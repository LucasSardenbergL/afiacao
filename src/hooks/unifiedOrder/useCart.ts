import { useState, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import type { OmieServico } from '@/services/omieService';
import type {
  Product,
  ProductAccount,
  ProductCartItem,
  ServiceCartItem,
  CartItem,
  UserTool,
} from '@/hooks/useUnifiedOrder';
import { nascerItemProduto } from './nascimento-item';

const VOLUME_UNITS = ['5L', 'GL', 'LT', 'BD', 'BH'];

interface UseCartArgs {
  getProductPrice: (product: Product) => number;
  getServicePrice: (item: ServiceCartItem) => number | null;
  servicos: OmieServico[];
}

export function useCart({ getProductPrice, getServicePrice, servicos }: UseCartArgs) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [tintPendingProduct, setTintPendingProductState] = useState<Product | null>(null);
  // Quantidade digitada na lista viaja até a confirmação da cor — antes a base
  // tintométrica abria o diálogo e o item nascia com 1, perdendo a qtd em silêncio.
  const [tintPendingQty, setTintPendingQty] = useState(1);
  const setTintPendingProduct = useCallback((product: Product | null, qty: number = 1) => {
    setTintPendingProductState(product);
    setTintPendingQty(Number.isFinite(qty) && qty > 0 ? qty : 1);
  }, []);
  const [activeTab, setActiveTab] = useState('oben');

  /* ─── Derived ─── */
  const productItems = useMemo(
    () => cart.filter((c): c is ProductCartItem => c.type === 'product'),
    [cart],
  );
  const obenProductItems = useMemo(
    () => productItems.filter(c => c.account === 'oben'),
    [productItems],
  );
  const colacorProductItems = useMemo(
    () => productItems.filter(c => c.account === 'colacor'),
    [productItems],
  );
  const serviceItems = useMemo(
    () => cart.filter((c): c is ServiceCartItem => c.type === 'service'),
    [cart],
  );
  const cartProductIds = useMemo(() => productItems.map(c => c.product.id), [productItems]);

  /* ─── Volume calculations ───
   * Packaging units (5L, GL, LT, BD, BH) count their qty;
   * all others contribute 1 volume total. */
  const calcVolumes = (items: ProductCartItem[]) => {
    let volumeQty = 0;
    let hasNonVolume = false;
    for (const item of items) {
      const un = (item.product.unidade || '').toUpperCase().trim();
      if (VOLUME_UNITS.includes(un)) volumeQty += item.quantity;
      else hasNonVolume = true;
    }
    return volumeQty + (hasNonVolume ? 1 : 0);
  };
  const volumesOben = useMemo(() => calcVolumes(obenProductItems), [obenProductItems]);
  const volumesColacor = useMemo(() => calcVolumes(colacorProductItems), [colacorProductItems]);

  /* ─── Subtotals ─── */
  const obenSubtotal = useMemo(
    () => obenProductItems.reduce((s, c) => s + c.quantity * c.unit_price, 0),
    [obenProductItems],
  );
  const colacorProdSubtotal = useMemo(
    () => colacorProductItems.reduce((s, c) => s + c.quantity * c.unit_price, 0),
    [colacorProductItems],
  );
  const serviceSubtotal = useMemo(() => {
    return serviceItems.reduce((s, c) => {
      const price = getServicePrice(c);
      return s + (price !== null ? price * c.quantity : 0);
    }, 0);
  }, [serviceItems, getServicePrice]);
  const totalEstimated = obenSubtotal + colacorProdSubtotal + serviceSubtotal;

  /* ─── Product actions ─── */
  const addProductToCart = useCallback(
    (product: Product, qty: number = 1) => {
      // Tintometric base → open color dialog instead of adding directly
      if (product.is_tintometric && product.tint_type === 'base') {
        setTintPendingProduct(product, qty);
        return;
      }
      setCart(prev => {
        const existing = prev.find(
          (c): c is ProductCartItem =>
            c.type === 'product' && c.product.id === product.id && !c.tint_formula_id,
        );
        if (existing) {
          return prev.map(c =>
            c.type === 'product' &&
            (c as ProductCartItem).product.id === product.id &&
            !(c as ProductCartItem).tint_formula_id
              ? ({ ...c, quantity: c.quantity + qty } as ProductCartItem)
              : c,
          );
        }
        // Mesma função de nascimento do caminho da IA (handleUnifiedAIResult): um decisor de preço só.
        return [...prev, nascerItemProduto(product, qty, getProductPrice)];
      });
    },
    [getProductPrice, setTintPendingProduct],
  );

  const addTintProductToCart = useCallback(
    (
      product: Product,
      formulaId: string,
      corId: string,
      nomeCor: string,
      precoFinal: number,
      custoCorantes: number,
      // Fase 3: fonte escolhida + desconto declarado (o gate do submit revalida)
      pricingMeta?: { source: string | null; discountPct: number; precoSemDesconto: number | null },
      // Fase 2A: entrada SEM diálogo pendente (1 toque das "Cores do cliente") traz a própria qtd;
      // sem ela, vale a qtd pendente do diálogo (Fase 1).
      qtyOverride?: number,
    ) => {
      const account = (product.account || 'oben') as ProductAccount;
      const qty = qtyOverride != null && Number.isFinite(qtyOverride) && qtyOverride > 0 ? qtyOverride : tintPendingQty;
      // Codex P1 (Fase 2A): só SOMA na linha existente quando a decisão de preço é a MESMA
      // (preço, fonte, desconto, preço-base). Antes somava por fórmula e as unidades novas
      // herdavam o desconto antigo sem escolha ativa — o gate aceitava (metadados coerentes).
      // Decisão DIFERENTE para a mesma fórmula → RECUSA com aviso (rodada 2: uma 2ª linha da
      // mesma fórmula duplicava a chave do carrinho e misturava a margem entre as linhas).
      const fonte = pricingMeta?.source ?? null;
      const desconto = fonte ? pricingMeta!.discountPct : undefined;
      const precoBase = fonte ? pricingMeta!.precoSemDesconto ?? undefined : undefined;
      const mesmaDecisao = (c: ProductCartItem) =>
        c.tint_formula_id === formulaId &&
        c.unit_price === precoFinal &&
        (c.tint_price_source ?? null) === fonte &&
        c.tint_discount_pct === desconto &&
        c.tint_preco_sem_desconto === precoBase;
      const conflito = cart.some(
        (c) => c.type === 'product' && (c as ProductCartItem).tint_formula_id === formulaId && !mesmaDecisao(c as ProductCartItem),
      );
      if (conflito) {
        toast.warning('Esta cor já está no carrinho com outro preço', {
          description: 'Ajuste a quantidade (ou o preço) na linha que já existe.',
        });
        setTintPendingProduct(null);
        return;
      }
      setCart(prev => {
        const idx = prev.findIndex((c) => c.type === 'product' && mesmaDecisao(c as ProductCartItem));
        if (idx >= 0) {
          return prev.map((c, i) =>
            i === idx ? ({ ...c, quantity: c.quantity + qty } as ProductCartItem) : c,
          );
        }
        // Mesma checagem sobre o estado ATUAL (o `cart` da closure pode estar 1 tick atrás):
        // nunca nasce 2ª linha da mesma fórmula.
        if (prev.some((c) => c.type === 'product' && (c as ProductCartItem).tint_formula_id === formulaId)) return prev;
        return [
          ...prev,
          {
            type: 'product',
            product,
            quantity: qty,
            unit_price: precoFinal,
            account,
            tint_cor_id: corId,
            tint_nome_cor: nomeCor,
            tint_custo_corantes: custoCorantes,
            tint_formula_id: formulaId,
            ...(pricingMeta?.source
              ? {
                  tint_price_source: pricingMeta.source,
                  tint_discount_pct: pricingMeta.discountPct,
                  ...(pricingMeta.precoSemDesconto != null
                    ? { tint_preco_sem_desconto: pricingMeta.precoSemDesconto }
                    : {}),
                }
              : {}),
          } as ProductCartItem,
        ];
      });
      setTintPendingProduct(null);
    },
    [cart, tintPendingQty, setTintPendingProduct],
  );

  /* ─── Service actions ─── */
  const addServiceToCart = useCallback(
    (tool: UserTool) => {
      let alreadyExists = false;
      setCart(prev => {
        if (prev.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === tool.id)) {
          alreadyExists = true;
          return prev;
        }
        return [
          ...prev,
          { type: 'service', userTool: tool, servico: null, quantity: 1, photos: [] } as ServiceCartItem,
        ];
      });
      if (alreadyExists) {
        toast.success('Já adicionada', { description: 'Esta ferramenta já está no carrinho.' });
      }
    },
    [],
  );

  const updateServiceServico = useCallback(
    (toolId: string, codigoServico: number) => {
      const servico = servicos.find(s => s.omie_codigo_servico === codigoServico) || null;
      setCart(prev =>
        prev.map(c =>
          c.type === 'service' && (c as ServiceCartItem).userTool.id === toolId
            ? ({ ...c, servico } as ServiceCartItem)
            : c,
        ),
      );
    },
    [servicos],
  );

  const updateServiceNotes = useCallback((toolId: string, newNotes: string) => {
    setCart(prev =>
      prev.map(c =>
        c.type === 'service' && (c as ServiceCartItem).userTool.id === toolId
          ? ({ ...c, notes: newNotes } as ServiceCartItem)
          : c,
      ),
    );
  }, []);

  const updateServicePhotos = useCallback((toolId: string, photos: string[]) => {
    setCart(prev =>
      prev.map(c =>
        c.type === 'service' && (c as ServiceCartItem).userTool.id === toolId
          ? ({ ...c, photos } as ServiceCartItem)
          : c,
      ),
    );
  }, []);

  /* ─── Generic ─── */
  const updateQuantity = useCallback(
    (index: number, delta: number) => {
      setCart(prev =>
        prev.map((c, i) => {
          if (i !== index) return c;
          const newQty = c.quantity + delta;
          if (c.type === 'service') {
            const maxQty = (c as ServiceCartItem).userTool.quantity || 1;
            if (newQty > maxQty) {
              toast.success('Quantidade máxima', { description: `Máximo: ${maxQty} unidades.` });
              return c;
            }
          }
          return newQty > 0 ? { ...c, quantity: newQty } : c;
        }),
      );
    },
    [],
  );

  const updateProductPrice = useCallback((index: number, price: number) => {
    setCart(prev =>
      prev.map((c, i) =>
        i === index && c.type === 'product' ? ({ ...c, unit_price: price } as ProductCartItem) : c,
      ),
    );
  }, []);

  const removeFromCart = useCallback((index: number) => {
    setCart(prev => prev.filter((_, i) => i !== index));
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
  }, []);

  return {
    // state
    cart,
    setCart,
    tintPendingProduct,
    setTintPendingProduct,
    activeTab,
    setActiveTab,
    // derived
    productItems,
    obenProductItems,
    colacorProductItems,
    serviceItems,
    cartProductIds,
    // volume
    volumesOben,
    volumesColacor,
    // totals
    obenSubtotal,
    colacorProdSubtotal,
    serviceSubtotal,
    totalEstimated,
    // actions
    addProductToCart,
    addTintProductToCart,
    addServiceToCart,
    updateServiceServico,
    updateServiceNotes,
    updateServicePhotos,
    updateQuantity,
    updateProductPrice,
    removeFromCart,
    clearCart,
  };
}
