import { useState, useMemo, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import type { OmieServico } from '@/services/omieService';
import type {
  Product,
  ProductAccount,
  ProductCartItem,
  ServiceCartItem,
  CartItem,
  UserTool,
} from '@/hooks/useUnifiedOrder';

export const VOLUME_UNITS = ['5L', 'GL', 'LT', 'BD', 'BH'];

interface UseCartArgs {
  getProductPrice: (product: Product) => number;
  getServicePrice: (item: ServiceCartItem) => number | null;
}

export function useCart({ getProductPrice, getServicePrice }: UseCartArgs) {
  const { toast } = useToast();

  const [cart, setCart] = useState<CartItem[]>([]);
  const [tintPendingProduct, setTintPendingProduct] = useState<Product | null>(null);
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
        setTintPendingProduct(product);
        return;
      }
      const account = (product.account || 'oben') as ProductAccount;
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
        return [
          ...prev,
          {
            type: 'product',
            product,
            quantity: qty,
            unit_price: getProductPrice(product),
            account,
          } as ProductCartItem,
        ];
      });
    },
    [getProductPrice],
  );

  const addTintProductToCart = useCallback(
    (
      product: Product,
      formulaId: string,
      corId: string,
      nomeCor: string,
      precoFinal: number,
      custoCorantes: number,
    ) => {
      const account = (product.account || 'oben') as ProductAccount;
      setCart(prev => {
        const existing = prev.find(
          (c): c is ProductCartItem => c.type === 'product' && c.tint_formula_id === formulaId,
        );
        if (existing) {
          return prev.map(c =>
            c.type === 'product' && (c as ProductCartItem).tint_formula_id === formulaId
              ? ({ ...c, quantity: c.quantity + 1 } as ProductCartItem)
              : c,
          );
        }
        return [
          ...prev,
          {
            type: 'product',
            product,
            quantity: 1,
            unit_price: precoFinal,
            account,
            tint_cor_id: corId,
            tint_nome_cor: nomeCor,
            tint_custo_corantes: custoCorantes,
            tint_formula_id: formulaId,
          } as ProductCartItem,
        ];
      });
      setTintPendingProduct(null);
    },
    [],
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
        toast({ title: 'Já adicionada', description: 'Esta ferramenta já está no carrinho.' });
      }
    },
    [toast],
  );

  const updateServiceServico = useCallback(
    (toolId: string, codigoServico: number, servicos: OmieServico[]) => {
      const servico = servicos.find(s => s.omie_codigo_servico === codigoServico) || null;
      setCart(prev =>
        prev.map(c =>
          c.type === 'service' && (c as ServiceCartItem).userTool.id === toolId
            ? ({ ...c, servico } as ServiceCartItem)
            : c,
        ),
      );
    },
    [],
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
              toast({ title: 'Quantidade máxima', description: `Máximo: ${maxQty} unidades.` });
              return c;
            }
          }
          return newQty > 0 ? { ...c, quantity: newQty } : c;
        }),
      );
    },
    [toast],
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
