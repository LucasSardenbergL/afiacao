import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RecommendationsPanel } from '@/components/RecommendationsPanel';
import { AddToolDialog } from '@/components/AddToolDialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { syncOrderToOmie, OmieServico } from '@/services/omieService';
import { usePricingEngine } from '@/hooks/usePricingEngine';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';
import {
  Loader2, Search, Plus, Minus, Trash2, User, ShoppingCart, Send,
  ChevronLeft, Package, CheckCircle, Wrench, AlertCircle, Scissors,
} from 'lucide-react';

/* ─── Types ─── */
interface Product {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  omie_codigo_produto: number;
}

interface ProductCartItem {
  type: 'product';
  product: Product;
  quantity: number;
  unit_price: number;
}

interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  specifications: Record<string, unknown> | null;
  tool_categories?: { name: string };
}

interface ServiceCartItem {
  type: 'service';
  userTool: UserTool;
  servico: OmieServico | null;
  quantity: number;
  notes?: string;
}

type CartItem = ProductCartItem | ServiceCartItem;

interface OmieCustomer {
  codigo_cliente: number;
  razao_social: string;
  nome_fantasia: string;
  cnpj_cpf: string;
  codigo_vendedor: number | null;
  local_user_id?: string | null;
}

interface FormaPagamento {
  codigo: string;
  descricao: string;
}

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const getToolName = (t: UserTool) => t.generated_name || t.custom_name || t.tool_categories?.name || 'Ferramenta';

/* ─── Stepper ─── */
function OrderStepper({ step }: { step: number }) {
  const steps = ['Cliente', 'Itens', 'Revisão'];
  return (
    <div className="flex items-center gap-2 mb-4">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div className={cn(
            'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
            i <= step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
          )}>
            {i < step ? <CheckCircle className="w-3.5 h-3.5" /> : i + 1}
          </div>
          <span className={cn('text-xs font-medium', i <= step ? 'text-foreground' : 'text-muted-foreground')}>{s}</span>
          {i < steps.length - 1 && <div className={cn('w-8 h-px', i < step ? 'bg-primary' : 'bg-border')} />}
        </div>
      ))}
    </div>
  );
}

/* ─── Main ─── */
const UnifiedOrder = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  // Customer
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<OmieCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<OmieCustomer | null>(null);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [loadingCustomer, setLoadingCustomer] = useState(false);
  const [customerUserId, setCustomerUserId] = useState<string | null>(null);

  // Products (Oben)
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [customerPrices, setCustomerPrices] = useState<Record<number, number>>({});

  // Afiação (Colacor)
  const [userTools, setUserTools] = useState<UserTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [servicos, setServicos] = useState<OmieServico[]>([]);
  const [loadingServicos, setLoadingServicos] = useState(true);
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);
  const [creatingLocalProfile, setCreatingLocalProfile] = useState(false);

  // Payment
  const [formasPagamento, setFormasPagamento] = useState<FormaPagamento[]>([]);
  const [selectedParcela, setSelectedParcela] = useState<string>('999');
  const [loadingFormas, setLoadingFormas] = useState(false);

  // Cart
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('products');

  // Pricing
  const { loadDefaultPrices, calculatePrice } = usePricingEngine();
  const { loadPriceHistory, getLastPrice } = usePriceHistory(customerUserId || undefined);

  const productItems = useMemo(() => cart.filter((c): c is ProductCartItem => c.type === 'product'), [cart]);
  const serviceItems = useMemo(() => cart.filter((c): c is ServiceCartItem => c.type === 'service'), [cart]);
  const cartProductIds = useMemo(() => productItems.map(c => c.product.id), [productItems]);

  const currentStep = !selectedCustomer ? 0 : cart.length === 0 ? 1 : 2;

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff]);

  useEffect(() => {
    if (isStaff) {
      loadProducts();
      loadFormasPagamento();
      loadServicosColacor();
      loadDefaultPrices();
    }
  }, [isStaff]);

  // Customer search (Oben Omie account)
  useEffect(() => {
    if (customerSearch.length < 2) { setCustomers([]); return; }
    const timeout = setTimeout(async () => {
      setSearchingCustomers(true);
      try {
        const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_clientes', search: customerSearch },
        });
        if (!error && data?.clientes) {
          const clientes = data.clientes as OmieCustomer[];
          // Find local user mappings
          if (clientes.length > 0) {
            const codigos = clientes.map(c => c.codigo_cliente);
            const { data: mappings } = await supabase
              .from('omie_clientes')
              .select('user_id, omie_codigo_cliente')
              .in('omie_codigo_cliente', codigos);
            if (mappings) {
              for (const c of clientes) {
                const m = mappings.find(mm => mm.omie_codigo_cliente === c.codigo_cliente);
                if (m) c.local_user_id = m.user_id;
              }
            }
          }
          setCustomers(clientes);
        }
      } catch (e) { console.error(e); }
      finally { setSearchingCustomers(false); }
    }, 500);
    return () => clearTimeout(timeout);
  }, [customerSearch]);

  const loadProducts = async () => {
    try {
      const { data } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto')
        .order('descricao');
      if (!data || data.length === 0) {
        try {
          let nextPage: number | null = 1;
          while (nextPage) {
            const { data: syncResult, error: syncError } = await supabase.functions.invoke('omie-vendas-sync', {
              body: { action: 'sync_products', start_page: nextPage },
            });
            if (syncError) throw syncError;
            nextPage = syncResult.nextPage || null;
          }
          const { data: refreshed } = await supabase
            .from('omie_products')
            .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto')
            .order('descricao');
          setProducts((refreshed || []) as Product[]);
        } catch (syncErr) { console.error('Sync error:', syncErr); }
      } else {
        setProducts(data as Product[]);
      }
      // Sync stock in background (Oben - ListarPosEstoque)
      syncStockInBackground();
    } catch (e) { console.error(e); }
    finally { setLoadingProducts(false); }
  };

  const syncStockInBackground = async () => {
    try {
      let nextPage: number | null = 1;
      while (nextPage) {
        const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'sync_estoque', start_page: nextPage },
        });
        if (error) break;
        nextPage = data?.nextPage || null;
      }
      // Refresh products with updated stock
      const { data: refreshed } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto')
        .order('descricao');
      if (refreshed) setProducts(refreshed as Product[]);
    } catch (e) { console.error('Background stock sync error:', e); }
  };

  const loadServicosColacor = async () => {
    try {
      setLoadingServicos(true);
      const { data } = await supabase
        .from('omie_servicos')
        .select('omie_codigo_servico, omie_codigo_integracao, descricao')
        .eq('inativo', false)
        .order('descricao');
      if (data) {
        setServicos(data.map(s => ({
          omie_codigo_servico: s.omie_codigo_servico,
          omie_codigo_integracao: s.omie_codigo_integracao || '',
          descricao: s.descricao,
          codigo_lc116: '', codigo_servico_municipio: '',
          valor_unitario: 0, unidade: 'UN',
        })));
      }
    } catch (e) { console.error(e); }
    finally { setLoadingServicos(false); }
  };

  const loadFormasPagamento = async () => {
    setLoadingFormas(true);
    try {
      const { data } = await supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'listar_formas_pagamento' },
      });
      if (data?.formas) setFormasPagamento(data.formas);
    } catch (e) { console.error(e); }
    finally { setLoadingFormas(false); }
  };

  const loadUserTools = async (userId: string) => {
    setLoadingTools(true);
    try {
      const { data } = await supabase
        .from('user_tools')
        .select('id, tool_category_id, generated_name, custom_name, quantity, specifications, tool_categories(name)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      setUserTools((data || []) as UserTool[]);
    } catch (e) { console.error(e); }
    finally { setLoadingTools(false); }
  };

  const selectCustomer = async (cust: OmieCustomer) => {
    setLoadingCustomer(true);
    setCustomerSearch('');
    setCustomers([]);
    setCart([]);
    try {
      setSelectedCustomer(cust);

      // Resolve local user_id
      let localUserId = cust.local_user_id || null;
      if (!localUserId) {
        const { data: mapping } = await supabase
          .from('omie_clientes')
          .select('user_id')
          .eq('omie_codigo_cliente', cust.codigo_cliente)
          .maybeSingle();
        if (mapping?.user_id) localUserId = mapping.user_id;
      }
      if (localUserId) {
        setCustomerUserId(localUserId);
        loadUserTools(localUserId);
        loadPriceHistory();
      }

      // Load prices from Omie + local history + last parcela — all in parallel
      const [priceResult, parcelaResult, localPriceResult] = await Promise.all([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_precos_cliente', codigo_cliente: cust.codigo_cliente },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente },
        }),
        localUserId
          ? supabase
              .from('sales_price_history')
              .select('product_id, unit_price, created_at')
              .eq('customer_user_id', localUserId)
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: null }),
      ]);

      // Merge: local history as base, Omie prices override
      const mergedPrices: Record<number, number> = {};

      // 1) Local sales_price_history → map product UUIDs to omie_codigo_produto
      if (localPriceResult.data && localPriceResult.data.length > 0) {
        const localPricesByProduct: Record<string, number> = {};
        for (const row of localPriceResult.data) {
          if (!localPricesByProduct[row.product_id]) {
            localPricesByProduct[row.product_id] = row.unit_price;
          }
        }
        const productIds = Object.keys(localPricesByProduct);
        if (productIds.length > 0) {
          const { data: productMappings } = await supabase
            .from('omie_products')
            .select('id, omie_codigo_produto')
            .in('id', productIds);
          if (productMappings) {
            for (const pm of productMappings) {
              const price = localPricesByProduct[pm.id];
              if (price && price > 0) mergedPrices[pm.omie_codigo_produto] = price;
            }
          }
        }
      }

      // 2) Omie prices override local (authoritative source)
      if (priceResult.data?.precos) {
        const omiePrecos = priceResult.data.precos as Record<string, number>;
        for (const [key, val] of Object.entries(omiePrecos)) {
          if (val && val > 0) mergedPrices[Number(key)] = val;
        }
      }

      setCustomerPrices(mergedPrices);
      if (parcelaResult.data?.ultima_parcela) setSelectedParcela(parcelaResult.data.ultima_parcela);
    } catch (error: any) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    } finally {
      setLoadingCustomer(false);
    }
  };

  // ─── Product Cart Actions ───
  const getProductPrice = useCallback((product: Product): number => {
    const omiePrice = customerPrices[product.omie_codigo_produto];
    return (omiePrice && omiePrice > 0) ? omiePrice : product.valor_unitario;
  }, [customerPrices]);

  const addProductToCart = (product: Product) => {
    const existing = cart.find((c): c is ProductCartItem => c.type === 'product' && c.product.id === product.id);
    if (existing) {
      setCart(cart.map(c => c.type === 'product' && (c as ProductCartItem).product.id === product.id
        ? { ...c, quantity: c.quantity + 1 } as ProductCartItem : c));
    } else {
      setCart([...cart, { type: 'product', product, quantity: 1, unit_price: getProductPrice(product) }]);
    }
  };

  // ─── Service Cart Actions ───
  const addServiceToCart = (tool: UserTool) => {
    if (cart.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === tool.id)) {
      toast({ title: 'Já adicionada', description: 'Esta ferramenta já está no carrinho.' });
      return;
    }
    setCart([...cart, { type: 'service', userTool: tool, servico: null, quantity: 1 }]);
  };

  const updateServiceServico = (toolId: string, codigoServico: number) => {
    const servico = servicos.find(s => s.omie_codigo_servico === codigoServico) || null;
    setCart(cart.map(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === toolId
      ? { ...c, servico } as ServiceCartItem : c));
  };

  const getServicePrice = (item: ServiceCartItem): number | null => {
    const serviceType = item.servico?.descricao || '';
    const lastPrice = getLastPrice(item.userTool.id, serviceType);
    if (lastPrice !== null) return lastPrice;
    const specs = item.userTool.specifications as Record<string, string> | null;
    return calculatePrice({ tool_category_id: item.userTool.tool_category_id, specifications: specs });
  };

  const getFilteredServicos = (tool: UserTool): OmieServico[] => {
    const categoryName = tool.tool_categories?.name?.toLowerCase().trim();
    if (!categoryName) return [];
    return servicos.filter(s => s.descricao.toLowerCase().includes(categoryName));
  };

  // ─── Generic Cart ───
  const updateQuantity = (index: number, delta: number) => {
    setCart(cart.map((c, i) => {
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
    }));
  };

  const updateProductPrice = (index: number, price: number) => {
    setCart(cart.map((c, i) => i === index && c.type === 'product' ? { ...c, unit_price: price } as ProductCartItem : c));
  };

  const removeFromCart = (index: number) => {
    setCart(cart.filter((_, i) => i !== index));
  };

  const productSubtotal = useMemo(() => productItems.reduce((s, c) => s + c.quantity * c.unit_price, 0), [productItems]);
  const serviceSubtotal = useMemo(() => {
    return serviceItems.reduce((s, c) => {
      const price = getServicePrice(c);
      return s + (price !== null ? price * c.quantity : 0);
    }, 0);
  }, [serviceItems]);
  const totalEstimated = productSubtotal + serviceSubtotal;

  const filteredProducts = useMemo(() => {
    const sorted = [...products].sort((a, b) => {
      if (a.ativo && !b.ativo) return -1;
      if (!a.ativo && b.ativo) return 1;
      return 0;
    });
    if (!productSearch) return sorted.slice(0, 30);
    return sorted.filter(p =>
      p.descricao.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.codigo.toLowerCase().includes(productSearch.toLowerCase())
    ).slice(0, 30);
  }, [products, productSearch]);

  const availableTools = useMemo(() =>
    userTools.filter(t => !cart.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === t.id)),
    [userTools, cart]
  );

  // ─── Recommendation handler ───
  const handleAddRecommendation = useCallback((item: RecommendationItem) => {
    const product = products.find(p => p.id === item.product_id);
    if (product) addProductToCart(product);
  }, [products]);

  // ─── Create local profile for Omie-only customers ───
  const handleStaffAddTool = async () => {
    if (!selectedCustomer) return;
    if (customerUserId) { setAddToolDialogOpen(true); return; }
    setCreatingLocalProfile(true);
    try {
      const { data: existingMapping } = await supabase
        .from('omie_clientes')
        .select('user_id')
        .eq('omie_codigo_cliente', selectedCustomer.codigo_cliente)
        .maybeSingle();
      if (existingMapping) {
        setCustomerUserId(existingMapping.user_id);
        loadUserTools(existingMapping.user_id);
        setAddToolDialogOpen(true);
        return;
      }
      const { data: result, error } = await supabase.functions.invoke('omie-cliente', {
        body: {
          action: 'criar_perfil_local',
          cliente: {
            codigo_cliente: selectedCustomer.codigo_cliente,
            razao_social: selectedCustomer.razao_social,
            nome_fantasia: selectedCustomer.nome_fantasia,
            cnpj_cpf: selectedCustomer.cnpj_cpf,
          },
        },
      });
      if (error) throw error;
      const localUserId = result?.user_id;
      if (!localUserId) throw new Error('Falha ao criar perfil');
      setCustomerUserId(localUserId);
      setSelectedCustomer(prev => prev ? { ...prev, local_user_id: localUserId } : prev);
      toast({ title: 'Perfil criado', description: 'Agora cadastre as ferramentas.' });
      setAddToolDialogOpen(true);
    } catch (e) {
      console.error(e);
      toast({ title: 'Erro', description: 'Não foi possível preparar o cadastro.', variant: 'destructive' });
    } finally {
      setCreatingLocalProfile(false);
    }
  };

  // ─── Submit ───
  const submitOrder = async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    setSubmitting(true);

    const hasProducts = productItems.length > 0;
    const hasServices = serviceItems.length > 0;
    const results: string[] = [];

    try {
      // 1. Oben: Sales order (products)
      if (hasProducts) {
        const itemsPayload = productItems.map(c => ({
          product_id: c.product.id,
          omie_codigo_produto: c.product.omie_codigo_produto,
          codigo: c.product.codigo,
          descricao: c.product.descricao,
          unidade: c.product.unidade,
          quantidade: c.quantity,
          valor_unitario: c.unit_price,
          valor_total: c.quantity * c.unit_price,
        }));

        const { data: salesOrder, error: insertError } = await supabase
          .from('sales_orders')
          .insert({
            customer_user_id: customerUserId || user.id,
            created_by: user.id,
            items: itemsPayload,
            subtotal: productSubtotal,
            total: productSubtotal,
            status: 'rascunho',
            notes: notes || null,
          })
          .select('id')
          .single();

        if (insertError) throw insertError;

        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido',
            sales_order_id: salesOrder.id,
            codigo_cliente: selectedCustomer.codigo_cliente,
            codigo_vendedor: selectedCustomer.codigo_vendedor,
            items: productItems.map(c => ({
              omie_codigo_produto: c.product.omie_codigo_produto,
              quantidade: c.quantity,
              valor_unitario: c.unit_price,
            })),
            observacao: notes,
            codigo_parcela: selectedParcela,
          },
        });

        if (!omieError) {
          results.push(`Pedido Venda ${omieResult?.omie_numero_pedido || ''}`);
        } else {
          results.push('Pedido Venda (pendente ERP)');
        }
      }

      // 2. Colacor: Service order (afiação)
      if (hasServices) {
        const orderId = crypto.randomUUID();
        const orderItems = serviceItems.map(c => {
          const price = getServicePrice(c);
          return {
            category: c.servico?.descricao || '',
            quantity: c.quantity,
            omie_codigo_servico: c.servico?.omie_codigo_servico,
            userToolId: c.userTool.id,
            toolName: getToolName(c.userTool),
            notes: c.notes,
            photos: [],
            unitPrice: price || 0,
            toolCategoryId: c.userTool.tool_category_id,
            toolSpecs: c.userTool.specifications || {},
          };
        });

        const orderData = {
          items: orderItems,
          service_type: 'padrao',
          subtotal: serviceSubtotal,
          delivery_fee: 0,
          total: serviceSubtotal,
          notes: serviceItems.map(c => {
            const parts: string[] = [];
            parts.push(getToolName(c.userTool));
            if (c.notes) parts.push(c.notes);
            return parts.join(' | ');
          }).join(' || '),
        };

        const profileData = {
          name: selectedCustomer.nome_fantasia || selectedCustomer.razao_social,
          document: selectedCustomer.cnpj_cpf || undefined,
        };

        const staffContext = {
          customerOmieCode: selectedCustomer.codigo_cliente,
          customerUserId: customerUserId || null,
        };

        const result = await syncOrderToOmie(orderId, orderData, profileData, undefined, staffContext);
        if (result.success) {
          results.push(`OS ${result.omie_os?.cNumOS || ''}`);
        } else {
          results.push('OS Afiação (pendente ERP)');
        }
      }

      toast({
        title: 'Pedido(s) enviado(s)!',
        description: results.join(' + '),
      });
      navigate('/sales');
    } catch (error: any) {
      toast({ title: 'Erro ao criar pedido', description: error.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return <div className="flex items-center justify-center py-32"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Novo Pedido</h1>
          <p className="text-xs text-muted-foreground">Pedido unificado: produtos + afiação para um único cliente.</p>
        </div>
      </div>

      <OrderStepper step={currentStep} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Main flow */}
        <div className="lg:col-span-2 space-y-4">
          {/* 1. Customer */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><User className="w-4 h-4" /> Cliente</CardTitle>
            </CardHeader>
            <CardContent>
              {selectedCustomer ? (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">{selectedCustomer.nome_fantasia || selectedCustomer.razao_social}</p>
                    <p className="text-xs text-muted-foreground">{selectedCustomer.cnpj_cpf}</p>
                    {!customerUserId && (
                      <p className="text-xs text-amber-600 mt-0.5">Sem cadastro no app</p>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => {
                    setSelectedCustomer(null);
                    setCustomerPrices({});
                    setCart([]);
                    setCustomerUserId(null);
                    setUserTools([]);
                    setSelectedParcela('999');
                  }}>
                    Trocar
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder="Buscar por nome ou CPF/CNPJ..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} className="pl-9 h-9" />
                  </div>
                  {(loadingCustomer || searchingCustomers) && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> Buscando...
                    </div>
                  )}
                  {customers.length > 0 && (
                    <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
                      {customers.map(c => (
                        <button key={c.codigo_cliente} className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors" onClick={() => selectCustomer(c)} disabled={loadingCustomer}>
                          <p className="text-sm font-medium">{c.nome_fantasia || c.razao_social}</p>
                          <p className="text-xs text-muted-foreground">{c.cnpj_cpf || 'Sem documento'}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 2. Tabbed catalog */}
          {selectedCustomer && (
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-3">
              <TabsList className="w-full grid grid-cols-2">
                <TabsTrigger value="products" className="gap-1.5">
                  <Package className="w-3.5 h-3.5" />
                  Produtos
                  {productItems.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{productItems.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="services" className="gap-1.5">
                  <Scissors className="w-3.5 h-3.5" />
                  Afiação
                  {serviceItems.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{serviceItems.length}</Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              {/* Products Tab */}
              <TabsContent value="products">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Package className="w-4 h-4" /> Catálogo de Produtos
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="relative mb-3">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input placeholder="Buscar produto..." value={productSearch} onChange={e => setProductSearch(e.target.value)} className="pl-9 h-9" />
                    </div>
                    {loadingProducts ? (
                      <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                    ) : (
                      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-card">
                            <tr className="border-b bg-muted/30">
                              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Produto</th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Preço</th>
                              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Estoque</th>
                              <th className="w-10"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredProducts.map(product => {
                              const isInCart = productItems.some(c => c.product.id === product.id);
                              const customerPrice = customerPrices[product.omie_codigo_produto];
                              return (
                                <tr key={product.id} className={cn('border-b last:border-b-0 hover:bg-muted/20 transition-colors', isInCart && 'bg-accent/20')}>
                                  <td className="px-3 py-2">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-xs truncate max-w-[200px]">{product.descricao}</span>
                                      {!product.ativo && <Badge variant="destructive" className="text-[9px] px-1 py-0">Inativo</Badge>}
                                      {customerPrice && customerPrice !== product.valor_unitario && (
                                        <Badge variant="secondary" className="text-[9px] px-1 py-0">Preço cliente</Badge>
                                      )}
                                    </div>
                                    <span className="text-[10px] text-muted-foreground font-mono">{product.codigo}</span>
                                  </td>
                                  <td className="px-3 py-2 text-right text-xs font-medium">
                                    {fmt(customerPrice || product.valor_unitario)}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    <Badge variant={product.estoque > 0 ? 'outline' : 'destructive'} className="text-[10px]">
                                      {product.estoque ?? 0}
                                    </Badge>
                                  </td>
                                  <td className="px-2 py-2">
                                    <Button size="sm" variant={isInCart ? 'secondary' : 'ghost'} className="h-7 w-7 p-0" onClick={() => addProductToCart(product)}>
                                      <Plus className="w-3.5 h-3.5" />
                                    </Button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Services Tab (Afiação) */}
              <TabsContent value="services">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Wrench className="w-4 h-4" /> Ferramentas do Cliente
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {loadingTools || loadingServicos ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin" />
                      </div>
                    ) : !customerUserId ? (
                      <div className="text-center py-6 space-y-3">
                        <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto" />
                        <p className="text-sm text-muted-foreground">Cliente sem cadastro no app. Crie o perfil para cadastrar ferramentas.</p>
                        <Button onClick={handleStaffAddTool} disabled={creatingLocalProfile} size="sm">
                          {creatingLocalProfile ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                          Criar perfil e cadastrar ferramenta
                        </Button>
                      </div>
                    ) : userTools.length === 0 ? (
                      <div className="text-center py-6 space-y-3">
                        <Wrench className="w-8 h-8 text-muted-foreground mx-auto" />
                        <p className="text-sm text-muted-foreground">Nenhuma ferramenta cadastrada para este cliente.</p>
                        <Button onClick={() => setAddToolDialogOpen(true)} size="sm">
                          <Plus className="w-4 h-4 mr-2" /> Cadastrar Ferramenta
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {/* Tools in cart - edit servico */}
                        {serviceItems.map((item, idx) => {
                          const filteredSvcs = getFilteredServicos(item.userTool);
                          const cartIdx = cart.indexOf(item);
                          return (
                            <div key={item.userTool.id} className="border rounded-lg p-3 bg-accent/10 space-y-2">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <Wrench className="w-4 h-4 text-primary" />
                                  <span className="text-sm font-medium">{getToolName(item.userTool)}</span>
                                </div>
                                <button onClick={() => removeFromCart(cartIdx)}>
                                  <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                                </button>
                              </div>
                              {filteredSvcs.length > 0 ? (
                                <select
                                  value={item.servico?.omie_codigo_servico || ''}
                                  onChange={e => updateServiceServico(item.userTool.id, Number(e.target.value))}
                                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
                                >
                                  <option value="">Selecione serviço...</option>
                                  {filteredSvcs.map(s => (
                                    <option key={s.omie_codigo_servico} value={s.omie_codigo_servico}>{s.descricao}</option>
                                  ))}
                                </select>
                              ) : (
                                <p className="text-xs text-muted-foreground"><AlertCircle className="w-3 h-3 inline mr-1" />Nenhum serviço disponível</p>
                              )}
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Qtd:</span>
                                <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => updateQuantity(cartIdx, -1)}>
                                  <Minus className="w-3 h-3" />
                                </Button>
                                <span className="text-xs w-6 text-center font-medium">{item.quantity}</span>
                                <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => updateQuantity(cartIdx, 1)}>
                                  <Plus className="w-3 h-3" />
                                </Button>
                                <span className="text-xs text-muted-foreground ml-1">(máx: {item.userTool.quantity || 1})</span>
                              </div>
                            </div>
                          );
                        })}

                        {/* Available tools */}
                        {availableTools.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-2">
                              {serviceItems.length > 0 ? 'Adicionar mais:' : 'Ferramentas disponíveis:'}
                            </p>
                            <div className="space-y-1.5">
                              {availableTools.map(tool => (
                                <button
                                  key={tool.id}
                                  onClick={() => addServiceToCart(tool)}
                                  className="w-full p-2.5 rounded-lg border border-dashed border-border flex items-center gap-2 text-left hover:border-primary hover:bg-primary/5 transition-colors"
                                >
                                  <Wrench className="w-4 h-4 text-muted-foreground" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{getToolName(tool)}</p>
                                    <p className="text-[10px] text-muted-foreground">{tool.tool_categories?.name}</p>
                                  </div>
                                  <Plus className="w-4 h-4 text-primary" />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        <Button variant="ghost" size="sm" className="w-full" onClick={() => setAddToolDialogOpen(true)}>
                          <Plus className="w-4 h-4 mr-2" /> Cadastrar nova ferramenta
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </div>

        {/* Right: Cart sidebar */}
        <div className="space-y-4">
          <Card className="sticky top-20">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <ShoppingCart className="w-4 h-4" />
                Carrinho
                {cart.length > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{cart.length}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {cart.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">Nenhum item adicionado</p>
              ) : (
                <div className="space-y-3">
                  {/* Product items */}
                  {productItems.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        <Package className="w-3 h-3 inline mr-1" />Produtos
                      </p>
                      {productItems.map((item, idx) => {
                        const cartIdx = cart.indexOf(item);
                        return (
                          <div key={item.product.id} className="space-y-1.5 mb-2">
                            <div className="flex items-start justify-between gap-1.5">
                              <p className="text-xs font-medium flex-1 leading-tight">{item.product.descricao}</p>
                              <button onClick={() => removeFromCart(cartIdx)}>
                                <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                              </button>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="flex items-center gap-0.5">
                                <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => updateQuantity(cartIdx, -1)}>
                                  <Minus className="w-3 h-3" />
                                </Button>
                                <span className="text-xs w-6 text-center font-medium">{item.quantity}</span>
                                <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => updateQuantity(cartIdx, 1)}>
                                  <Plus className="w-3 h-3" />
                                </Button>
                              </div>
                              <div className="flex items-center gap-0.5 flex-1">
                                <span className="text-[10px] text-muted-foreground">R$</span>
                                <Input type="number" step="0.01" value={item.unit_price} onChange={e => updateProductPrice(cartIdx, parseFloat(e.target.value) || 0)} className="h-6 text-xs" />
                              </div>
                              <span className="text-xs font-semibold shrink-0">{fmt(item.quantity * item.unit_price)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Service items */}
                  {serviceItems.length > 0 && (
                    <div>
                      {productItems.length > 0 && <Separator className="my-2" />}
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        <Scissors className="w-3 h-3 inline mr-1" />Afiação
                      </p>
                      {serviceItems.map(item => {
                        const price = getServicePrice(item);
                        return (
                          <div key={item.userTool.id} className="flex items-center justify-between mb-1.5">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium truncate">{getToolName(item.userTool)}</p>
                              <p className="text-[10px] text-muted-foreground truncate">
                                {item.quantity}x {item.servico?.descricao || 'Selecione serviço'}
                              </p>
                            </div>
                            {price !== null ? (
                              <span className="text-xs font-semibold shrink-0">{fmt(price * item.quantity)}</span>
                            ) : (
                              <span className="text-[10px] text-muted-foreground italic shrink-0">A orçar</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <Separator />

                  {/* Totals */}
                  {productItems.length > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Produtos</span>
                      <span className="font-medium">{fmt(productSubtotal)}</span>
                    </div>
                  )}
                  {serviceItems.length > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Afiação</span>
                      <span className="font-medium">{serviceSubtotal > 0 ? fmt(serviceSubtotal) : 'A orçar'}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-bold">Total</span>
                    <span className="text-sm font-bold">{totalEstimated > 0 ? fmt(totalEstimated) : 'A definir'}</span>
                  </div>

                  {/* Info badges */}
                  <div className="flex flex-wrap gap-1">
                    {productItems.length > 0 && <Badge variant="outline" className="text-[9px]"><Package className="w-2.5 h-2.5 mr-0.5" />Oben</Badge>}
                    {serviceItems.length > 0 && <Badge variant="outline" className="text-[9px]"><Scissors className="w-2.5 h-2.5 mr-0.5" />Colacor</Badge>}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recommendations */}
          {customerUserId && productItems.length > 0 && (
            <RecommendationsPanel
              customerId={customerUserId}
              basketProductIds={cartProductIds}
              onAddToCart={handleAddRecommendation}
              title="Combine com"
              compact
              maxItems={5}
            />
          )}

          {/* Payment + Submit */}
          {cart.length > 0 && selectedCustomer && (
            <Card>
              <CardContent className="pt-4 space-y-3">
                {productItems.length > 0 && (
                  <div>
                    <Label className="text-xs font-medium">Pagamento (Produtos)</Label>
                    {loadingFormas ? (
                      <Loader2 className="w-4 h-4 animate-spin mt-1" />
                    ) : (
                      <Select value={selectedParcela} onValueChange={setSelectedParcela}>
                        <SelectTrigger className="text-sm h-9 mt-1">
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent>
                          {formasPagamento.map(f => (
                            <SelectItem key={f.codigo} value={f.codigo}>
                              {f.descricao}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
                <div>
                  <Label className="text-xs font-medium">Observações</Label>
                  <Textarea placeholder="Observações do pedido..." value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="text-sm mt-1" />
                </div>

                {/* Validation */}
                {serviceItems.some(s => !s.servico) && (
                  <p className="text-xs text-amber-600">
                    <AlertCircle className="w-3 h-3 inline mr-1" />
                    Selecione o serviço para cada ferramenta na aba Afiação.
                  </p>
                )}

                <Button
                  className="w-full gap-2"
                  onClick={submitOrder}
                  disabled={submitting || serviceItems.some(s => !s.servico)}
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Enviar pedido
                  {productItems.length > 0 && serviceItems.length > 0 && (
                    <span className="text-[10px] opacity-70">(2 pedidos)</span>
                  )}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Add Tool Dialog */}
      {customerUserId && (
        <AddToolDialog
          open={addToolDialogOpen}
          onOpenChange={setAddToolDialogOpen}
          categories={[]}
          targetUserId={customerUserId}
          onToolAdded={() => loadUserTools(customerUserId)}
        />
      )}
    </div>
  );
};

export default UnifiedOrder;
