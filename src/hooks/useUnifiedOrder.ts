import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { OmieServico } from '@/services/omieService';
import { usePricingEngine } from '@/hooks/usePricingEngine';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import { useCart, VOLUME_UNITS } from '@/hooks/unifiedOrder/useCart';
import { useCustomerSelection } from '@/hooks/unifiedOrder/useCustomerSelection';
import { useProductCatalog } from '@/hooks/unifiedOrder/useProductCatalog';
import { submitOrder as submitOrderService, submitQuote as submitQuoteService } from '@/services/orderSubmission';
import type { LastOrderDataShape } from '@/services/orderSubmission';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';
import { DeliveryOption } from '@/types';
import type { AIOrderResult, AICustomerMatch } from '@/components/UnifiedAIAssistant';
import type { IdentifiedItem } from '@/components/VoiceServiceInput';
import { logger } from '@/lib/logger';
import { maskDocument } from '@/lib/format';

// Re-export shared types for backwards compatibility
export { VOLUME_UNITS };
export type {
  ProductAccount,
  Product,
  ProductCartItem,
  UserTool,
  ServiceCartItem,
  CartItem,
  OmieCustomer,
  FormaPagamento,
  CompanyProfile,
  AddressData,
  ToolCategory,
} from '@/hooks/unifiedOrder/types';

import type {
  Product,
  ProductAccount,
  ProductCartItem,
  ServiceCartItem,
  CartItem,
  OmieCustomer,
  FormaPagamento,
  CompanyProfile,
  AddressData,
  ToolCategory,
  UserTool,
} from '@/hooks/unifiedOrder/types';

export const PAYMENT_OPTIONS = [
  { id: 'a_vista', label: 'À vista', description: 'PIX ou pagamento presencial na entrega/retirada' },
  { id: '30dd', label: '30 dias', description: 'Vencimento em 30 dias' },
  { id: '30_60dd', label: '30/60 dias', description: '2 parcelas: 30 e 60 dias' },
  { id: '30_60_90dd', label: '30/60/90 dias', description: '3 parcelas: 30, 60 e 90 dias' },
  { id: '28dd', label: '28 dias', description: 'Vencimento em 28 dias' },
  { id: '28_56dd', label: '28/56 dias', description: '2 parcelas: 28 e 56 dias' },
  { id: '28_56_84dd', label: '28/56/84 dias', description: '3 parcelas: 28, 56 e 84 dias' },
] as const;

export const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const getToolName = (t: UserTool) => t.generated_name || t.custom_name || t.tool_categories?.name || 'Ferramenta';

export function useUnifiedOrder() {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  // Company profiles (printing) — react-query, 1h stale
  const { data: companyProfiles = {} } = useQuery({
    queryKey: ['company-profiles'],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_profiles')
        .select('account, legal_name, cnpj, phone, address');
      if (error) throw error;
      const map: Record<string, CompanyProfile> = {};
      for (const row of data || []) map[row.account] = row as CompanyProfile;
      return map;
    },
  });

  // Product catalog state lives in useProductCatalog hook (declared after customer selection below)

  const queryClient = useQueryClient();

  // Afiação (userTools/loadingTools agora vêm do useQuery declarado após customerSel)
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);
  const [creatingLocalProfile, setCreatingLocalProfile] = useState(false);

  // Serviços Colacor — react-query, 5min stale (staff e customer usam)
  const { data: servicos = [], isLoading: loadingServicos } = useQuery<OmieServico[]>({
    queryKey: ['servicos-colacor'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('omie_servicos')
        .select('omie_codigo_servico, omie_codigo_integracao, descricao')
        .eq('inativo', false)
        .order('descricao');
      if (error) throw error;
      return (data || []).map((s) => ({
        omie_codigo_servico: s.omie_codigo_servico,
        omie_codigo_integracao: s.omie_codigo_integracao || '',
        descricao: s.descricao,
        codigo_lc116: '', codigo_servico_municipio: '',
        valor_unitario: 0, unidade: 'UN',
      }));
    },
  });

  // Tool categories — react-query, 30min stale
  const { data: toolCategories = [] } = useQuery<ToolCategory[]>({
    queryKey: ['tool-categories'],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tool_categories')
        .select('id, name, description, suggested_interval_days')
        .order('name');
      if (error) throw error;
      return (data || []) as ToolCategory[];
    },
  });

  // Payment (forms list & method) — react-query por conta, 10min stale, só staff
  const formasQueryFn = (account: ProductAccount) => async (): Promise<FormaPagamento[]> => {
    const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
      body: { action: 'listar_formas_pagamento', account },
    });
    if (error) throw error;
    return (data?.formas || []) as FormaPagamento[];
  };
  const obenFormasQuery = useQuery<FormaPagamento[]>({
    queryKey: ['formas-pagamento', 'oben'],
    enabled: isStaff,
    staleTime: 10 * 60 * 1000,
    queryFn: formasQueryFn('oben'),
  });
  const colacorFormasQuery = useQuery<FormaPagamento[]>({
    queryKey: ['formas-pagamento', 'colacor'],
    enabled: isStaff,
    staleTime: 10 * 60 * 1000,
    queryFn: formasQueryFn('colacor'),
  });
  const formasPagamentoOben = obenFormasQuery.data || [];
  const formasPagamentoColacor = colacorFormasQuery.data || [];
  const loadingFormas = obenFormasQuery.isLoading || colacorFormasQuery.isLoading;

  const [ordemCompra, setOrdemCompra] = useState<string>('');
  const [afiacaoPaymentMethod, setAfiacaoPaymentMethod] = useState<string>('a_vista');

  // Delivery
  const [deliveryOption, setDeliveryOption] = useState<DeliveryOption>('coleta_entrega');
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string>('');
  const [showAddressOptions, setShowAddressOptions] = useState(false);

  // Cart state lives in useCart hook (declared after pricing helpers below)
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // activeTab moved into useCart hook below
  const [readyByDate, setReadyByDate] = useState<string>('');
  const [defaultProductionAssigneeId, setDefaultProductionAssigneeId] = useState<string | null>(null);

  // Load default production assignee (configured via Governance > Settings).
  // Used to attribute auto-created Colacor production orders.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('company_config')
        .select('value')
        .eq('key', 'default_production_assignee_id')
        .maybeSingle();
      if (!cancelled) setDefaultProductionAssigneeId(data?.value || null);
    })();
    return () => { cancelled = true; };
  }, []);
  
  // Order success dialog
  const [orderSuccessOpen, setOrderSuccessOpen] = useState(false);
  const [lastOrderData, setLastOrderData] = useState<LastOrderDataShape | null>(null);

  // Pricing engine (calc-only, no customer dependency)
  const { loadDefaultPrices, calculatePrice } = usePricingEngine();

  // Customer selection (search, selection, prices, parcelas, addresses, history, vendedor validation)
  const customerSel = useCustomerSelection({
    onLocalUserResolved: () => { /* user-tools is auto-loaded via useQuery */ },
    reloadPriceHistory: () => { loadPriceHistory(); },
  });
  const {
    customerSearch, setCustomerSearch,
    customers, searchingCustomers,
    selectedCustomer, setSelectedCustomer,
    loadingCustomer,
    customerUserId, setCustomerUserId,
    requiresPo,
    customerPricesOben, setCustomerPricesOben,
    customerPricesColacor, setCustomerPricesColacor,
    selectedParcelaOben, setSelectedParcelaOben,
    selectedParcelaColacor, setSelectedParcelaColacor,
    customerParcelaRankingOben,
    customerParcelaRankingColacor,
    addresses,
    selectedAddress, setSelectedAddress,
    customerPurchaseHistory,
    vendedorDivergencias, validatingVendedor,
    selectCustomer, clearCustomer: clearCustomerInternal,
  } = customerSel;

  // User tools (afiação) — react-query, 2min stale; auto-loads quando customerUserId muda
  const { data: userTools = [], isLoading: loadingTools } = useQuery<UserTool[]>({
    queryKey: ['user-tools', customerUserId],
    enabled: !!customerUserId,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_tools')
        .select('id, tool_category_id, generated_name, custom_name, quantity, specifications, tool_categories(name)')
        .eq('user_id', customerUserId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as UserTool[];
    },
  });

  // Backward-compat: forces a refresh of the user-tools query (used by AddToolDialog onToolAdded)
  const loadUserTools = useCallback((_userId?: string) => {
    queryClient.invalidateQueries({ queryKey: ['user-tools'] });
  }, [queryClient]);

  // Pricing history (depends on customerUserId from above)
  const { loadPriceHistory, getLastPrice } = usePriceHistory(customerUserId || undefined);

  // Pricing helpers (defined here so useCart can depend on them)
  const getProductPrice = useCallback((product: Product): number => {
    const account = (product.account || 'oben') as ProductAccount;
    const prices = account === 'oben' ? customerPricesOben : customerPricesColacor;
    const omiePrice = prices[product.omie_codigo_produto];
    return (omiePrice && omiePrice > 0) ? omiePrice : product.valor_unitario;
  }, [customerPricesOben, customerPricesColacor]);

  const getServicePrice = useCallback((item: ServiceCartItem): number | null => {
    const serviceType = item.servico?.descricao || '';
    const lastPrice = getLastPrice(item.userTool.id, serviceType);
    if (lastPrice !== null) return lastPrice;
    const specs = item.userTool.specifications as Record<string, string> | null;
    return calculatePrice({ tool_category_id: item.userTool.tool_category_id, specifications: specs });
  }, [getLastPrice, calculatePrice]);

  // Cart hook — encapsulates cart state, derived items, totals, and actions
  const cartHook = useCart({ getProductPrice, getServicePrice, servicos });
  const {
    cart, setCart,
    tintPendingProduct, setTintPendingProduct,
    activeTab, setActiveTab,
    productItems, obenProductItems, colacorProductItems, serviceItems, cartProductIds,
    volumesOben, volumesColacor,
    obenSubtotal, colacorProdSubtotal, serviceSubtotal, totalEstimated,
    addProductToCart, addTintProductToCart, addServiceToCart,
    updateServiceServico, updateServiceNotes, updateServicePhotos,
    updateQuantity, updateProductPrice, removeFromCart, clearCart,
  } = cartHook;

  // Product catalog (Oben + Colacor) — só carrega para staff
  const catalog = useProductCatalog({
    enabled: isStaff,
    customerPricesOben,
    customerPricesColacor,
    customerPurchaseHistory,
  });
  const {
    obenProducts, colacorProducts,
    loadingObenProducts, loadingColacorProducts,
    productSearch, setProductSearch,
    filteredObenProducts, filteredColacorProducts,
    isProductPreviouslyPurchased, getProductLastOrderDate,
  } = catalog;

  // Wrap clearCustomer to also clear cart + ordem de compra
  const clearCustomer = useCallback(() => {
    clearCustomerInternal();
    setCart([]);
    setOrdemCompra('');
    // user-tools cache é invalidado dentro de clearCustomerInternal
  }, [clearCustomerInternal, setCart]);


  const sortedFormasPagamentoOben = useMemo(() => {
    if (customerParcelaRankingOben.length === 0) return formasPagamentoOben;
    const rankSet = new Set(customerParcelaRankingOben);
    return [...formasPagamentoOben].sort((a, b) => {
      const aR = customerParcelaRankingOben.indexOf(a.codigo);
      const bR = customerParcelaRankingOben.indexOf(b.codigo);
      if (rankSet.has(a.codigo) && !rankSet.has(b.codigo)) return -1;
      if (!rankSet.has(a.codigo) && rankSet.has(b.codigo)) return 1;
      if (rankSet.has(a.codigo) && rankSet.has(b.codigo)) return aR - bR;
      return 0;
    });
  }, [formasPagamentoOben, customerParcelaRankingOben]);

  const sortedFormasPagamentoColacor = useMemo(() => {
    if (customerParcelaRankingColacor.length === 0) return formasPagamentoColacor;
    const rankSet = new Set(customerParcelaRankingColacor);
    return [...formasPagamentoColacor].sort((a, b) => {
      const aR = customerParcelaRankingColacor.indexOf(a.codigo);
      const bR = customerParcelaRankingColacor.indexOf(b.codigo);
      if (rankSet.has(a.codigo) && !rankSet.has(b.codigo)) return -1;
      if (!rankSet.has(a.codigo) && rankSet.has(b.codigo)) return 1;
      if (rankSet.has(a.codigo) && rankSet.has(b.codigo)) return aR - bR;
      return 0;
    });
  }, [formasPagamentoColacor, customerParcelaRankingColacor]);

  const isCustomerMode = !authLoading && !isStaff;
  const currentStep = isCustomerMode
    ? (cart.length === 0 ? 1 : 2)
    : (!selectedCustomer ? 0 : cart.length === 0 ? 1 : 2);

  // Staff: load default prices (servicos/categorias/formas/companyProfiles agora via react-query)
  useEffect(() => {
    if (isStaff) {
      loadDefaultPrices();
    }
  }, [isStaff]);

  // Customer: auto-setup own context (skip customer search)
  useEffect(() => {
    if (!isCustomerMode || !user || selectedCustomer) return;
    // servicos/categorias/userTools/addresses agora vêm via react-query automaticamente
    // (basta setar customerUserId que as queries reagem)
    loadDefaultPrices();
    setCustomerUserId(user.id);
    loadPriceHistory();
    // Set a synthetic customer object so the UI considers customer selected
    (async () => {
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('name, document')
          .eq('user_id', user.id)
          .maybeSingle();
        setSelectedCustomer({
          codigo_cliente: 0,
          razao_social: profile?.name || user.email?.split('@')[0] || 'Cliente',
          nome_fantasia: profile?.name || '',
          cnpj_cpf: profile?.document || '',
          codigo_vendedor: null,
          local_user_id: user.id,
        });
      } catch (err) {
        logger.error('Failed to load customer profile in customer-mode auto-setup', {
          mode: 'customer',
          stage: 'customer_profile_load',
          customerUserId: user.id,
          error: err,
        });
      }
    })();
  }, [isCustomerMode, user]);

  // Customer search & selection now live in useCustomerSelection hook
  // loadProductsForAccount + syncStockInBackground now live in useProductCatalog hook
  // loadServicosColacor / loadCategories / loadCompanyProfiles / loadFormasPagamento /
  // loadUserTools / loadAddresses foram migrados para react-query (useQuery) acima.

  // loadAddresses & selectCustomer now live in useCustomerSelection hook

  // Cart actions and pricing helpers (getProductPrice, getServicePrice,
  // addProductToCart, addTintProductToCart, addServiceToCart, updateServiceServico,
  // updateServiceNotes, updateServicePhotos) are now provided by the useCart hook
  // and the pricing-helpers block defined earlier in this hook.


  const getFilteredServicos = (tool: UserTool): OmieServico[] => {
    const categoryName = tool.tool_categories?.name?.toLowerCase().trim();
    if (!categoryName) return [];
    return servicos.filter(s => s.descricao.toLowerCase().includes(categoryName));
  };

  // Voice / Image handlers
  const handleVoiceItemsIdentified = (identifiedItems: IdentifiedItem[]) => {
    const newItems: ServiceCartItem[] = identifiedItems.map((item) => {
      const tool = userTools.find(t => t.id === item.userToolId);
      const servico = servicos.find(s => s.omie_codigo_servico === item.omie_codigo_servico) || null;
      return {
        type: 'service' as const, userTool: tool!, servico, quantity: item.quantity,
        notes: item.notes, photos: [],
      };
    }).filter(item => item.userTool);

    const filteredNew = newItems.filter(
      newItem => !cart.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === newItem.userTool.id)
    );

    if (filteredNew.length === 0) {
      toast({ title: 'Ferramentas já adicionadas', description: 'Todas as ferramentas identificadas já estão no pedido.' });
      return;
    }
    setCart([...cart, ...filteredNew]);
  };

  const handleImageCategoryIdentified = (categoryId: string) => {
    const matchingTools = userTools.filter(t => t.tool_category_id === categoryId);
    if (matchingTools.length > 0) {
      let addedCount = 0;
      matchingTools.forEach(tool => {
        if (!cart.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === tool.id)) {
          addServiceToCart(tool);
          addedCount++;
        }
      });
      if (addedCount > 0) {
        toast({ title: 'Ferramenta encontrada!', description: `${addedCount} ferramenta(s) adicionada(s) ao pedido` });
      }
    } else {
      toast({ title: 'Ferramenta não cadastrada', description: 'Nenhuma ferramenta dessa categoria foi encontrada no cadastro.', variant: 'destructive' });
    }
  };

  // AI Customer handler
  const handleAICustomerSelect = useCallback(async (customer: AICustomerMatch) => {
    let codigoCliente = customer.codigo_cliente;
    if (!codigoCliente && customer.user_id) {
      const { data: omieMapping } = await supabase
        .from('omie_clientes').select('omie_codigo_cliente')
        .eq('user_id', customer.user_id).maybeSingle();
      if (omieMapping?.omie_codigo_cliente) codigoCliente = omieMapping.omie_codigo_cliente;
    }
    if (!codigoCliente && customer.cnpj_cpf) {
      try {
        const { data: omieResult } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_cliente', document: customer.cnpj_cpf, account: 'oben' },
        });
        if (omieResult?.codigo_cliente) codigoCliente = omieResult.codigo_cliente;
      } catch (e) {
        logger.error('Failed to resolve customer via Omie (AI flow)', {
          mode: 'staff',
          stage: 'ai_resolve_customer_omie',
          customerCnpjCpf: maskDocument(customer.cnpj_cpf),
          error: e,
        });
      }
    }
    const omieCustomer: OmieCustomer = {
      codigo_cliente: codigoCliente || 0,
      razao_social: customer.razao_social,
      nome_fantasia: customer.nome_fantasia,
      cnpj_cpf: customer.cnpj_cpf,
      codigo_vendedor: null,
      local_user_id: customer.user_id || undefined,
    };
    await selectCustomer(omieCustomer);
  }, [selectCustomer]);

  // Unified AI handler
  const handleUnifiedAIResult = useCallback((result: AIOrderResult) => {
    const newCartItems: CartItem[] = [];
    const allProducts = [...obenProducts, ...colacorProducts];
    for (const aiProd of result.products) {
      const product = allProducts.find(p => p.id === aiProd.product_id);
      if (!product) continue;
      const existing = cart.find((c): c is ProductCartItem => c.type === 'product' && c.product.id === product.id);
      if (existing) {
        setCart(prev => prev.map(c =>
          c.type === 'product' && (c as ProductCartItem).product.id === product.id
            ? { ...c, quantity: c.quantity + aiProd.quantity } as ProductCartItem : c
        ));
      } else {
        const account = (product.account || aiProd.account || 'oben') as ProductAccount;
        const aiPrice = aiProd.unit_price;
        const unitPrice = (aiPrice && aiPrice > 0) ? aiPrice : getProductPrice(product as Product);
        newCartItems.push({ type: 'product', product: product as Product, quantity: aiProd.quantity, unit_price: unitPrice, account });
      }
    }
    for (const aiSvc of result.services) {
      const tool = userTools.find(t => t.id === aiSvc.userToolId);
      if (!tool) continue;
      if (cart.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === tool.id)) continue;
      const servico = servicos.find(s => s.omie_codigo_servico === aiSvc.omie_codigo_servico) || null;
      newCartItems.push({ type: 'service', userTool: tool, servico, quantity: aiSvc.quantity, notes: aiSvc.notes, photos: [] });
    }
    if (newCartItems.length > 0) setCart(prev => [...prev, ...newCartItems]);
  }, [obenProducts, colacorProducts, userTools, servicos, cart, getProductPrice]);

  // Generic cart actions and subtotals (updateQuantity, updateProductPrice,
  // removeFromCart, obenSubtotal, colacorProdSubtotal, serviceSubtotal,
  // totalEstimated) are provided by the useCart hook above.


  // isProductPreviouslyPurchased, getProductLastOrderDate, filteredObenProducts,
  // filteredColacorProducts now live in useProductCatalog hook (destructured above).


  const availableTools = useMemo(() =>
    userTools.filter(t => !cart.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === t.id)),
    [userTools, cart]
  );

  const handleAddRecommendation = useCallback((item: RecommendationItem) => {
    const allProducts = [...obenProducts, ...colacorProducts];
    const product = allProducts.find(p => p.id === item.product_id);
    if (product) addProductToCart(product);
  }, [obenProducts, colacorProducts]);

  // Create local profile
  const handleStaffAddTool = async () => {
    if (!selectedCustomer) return;
    if (customerUserId) { setAddToolDialogOpen(true); return; }
    setCreatingLocalProfile(true);
    try {
      const { data: existingMapping } = await supabase
        .from('omie_clientes').select('user_id')
        .eq('omie_codigo_cliente', selectedCustomer.codigo_cliente).maybeSingle();
      if (existingMapping) {
        setCustomerUserId(existingMapping.user_id);
        loadUserTools(existingMapping.user_id);
        setAddToolDialogOpen(true);
        return;
      }
      if (selectedCustomer.cnpj_cpf) {
        const docClean = selectedCustomer.cnpj_cpf.replace(/\D/g, '');
        if (docClean.length >= 11) {
          const { data: profile } = await supabase
            .from('profiles').select('user_id').eq('document', docClean).maybeSingle();
          if (profile?.user_id) {
            setCustomerUserId(profile.user_id);
            loadUserTools(profile.user_id);
            setAddToolDialogOpen(true);
            return;
          }
        }
      }
      const { data: result, error } = await supabase.functions.invoke('omie-cliente', {
        body: {
          action: 'criar_perfil_local',
          cliente: {
            codigo_cliente: selectedCustomer.codigo_cliente,
            razao_social: selectedCustomer.razao_social,
            nome_fantasia: selectedCustomer.nome_fantasia,
            cnpj_cpf: selectedCustomer.cnpj_cpf,
            codigo_vendedor: selectedCustomer.codigo_vendedor,
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
      logger.error('Failed to prepare local profile for staff add-tool flow', {
        mode: 'staff',
        stage: 'create_local_profile',
        customerCnpjCpf: maskDocument(selectedCustomer.cnpj_cpf),
        codigoCliente: selectedCustomer.codigo_cliente,
        error: e,
      });
      toast({ title: 'Erro', description: 'Não foi possível preparar o cadastro.', variant: 'destructive' });
    } finally {
      setCreatingLocalProfile(false);
    }
  };

  // Submit — orchestrates state around the pure submit functions in services/orderSubmission
  const submitQuote = useCallback(async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    setSubmitting(true);
    try {
      const result = await submitQuoteService({
        customer: selectedCustomer,
        customerUserId,
        user,
        cart: { obenProductItems, colacorProductItems },
        subtotals: { oben: obenSubtotal, colacor: colacorProdSubtotal },
        delivery: {
          option: deliveryOption,
          selectedAddress: addresses.find(a => a.id === selectedAddress),
        },
        meta: { notes },
        supabase,
      });
      if (result.success) {
        toast({ title: 'Orçamento salvo', description: result.results.join(' | ') });
        clearCart();
        setNotes('');
        navigate('/sales/quotes');
      } else {
        toast({
          title: 'Erro ao salvar orçamento',
          description: result.errors[0]?.message || 'Falha desconhecida',
          variant: 'destructive',
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedCustomer, cart.length, user, customerUserId,
    obenProductItems, colacorProductItems, obenSubtotal, colacorProdSubtotal,
    deliveryOption, addresses, selectedAddress, notes,
    clearCart, toast, navigate,
  ]);

  const submitOrder = useCallback(async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    setSubmitting(true);
    try {
      const result = await submitOrderService({
        customer: selectedCustomer,
        customerUserId,
        user,
        cart: { obenProductItems, colacorProductItems, serviceItems },
        subtotals: { oben: obenSubtotal, colacor: colacorProdSubtotal, service: serviceSubtotal },
        volumes: { oben: volumesOben, colacor: volumesColacor },
        payment: {
          parcelaOben: selectedParcelaOben,
          parcelaColacor: selectedParcelaColacor,
          afiacaoMethod: afiacaoPaymentMethod,
          formasPagamentoOben,
          formasPagamentoColacor,
        },
        delivery: {
          option: deliveryOption,
          selectedAddress: addresses.find(a => a.id === selectedAddress),
        },
        meta: { notes, readyByDate, ordemCompra },
        companyProfiles,
        defaultProductionAssigneeId,
        getServicePrice,
        supabase,
      });
      if (result.success && result.lastOrderData) {
        setLastOrderData(result.lastOrderData);
        setOrderSuccessOpen(true);
        clearCart();
        setNotes('');
        if (result.errors.length > 0) {
          toast({
            title: 'Pedido criado com avisos',
            description: result.errors.map(e => e.message).join(' | '),
          });
        }
      } else {
        toast({
          title: 'Erro ao criar pedido',
          description: result.errors[0]?.message || 'Falha desconhecida',
          variant: 'destructive',
        });
      }
    } catch (error: any) {
      toast({ title: 'Erro ao criar pedido', description: error.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedCustomer, cart.length, user, customerUserId,
    obenProductItems, colacorProductItems, serviceItems,
    obenSubtotal, colacorProdSubtotal, serviceSubtotal,
    volumesOben, volumesColacor,
    selectedParcelaOben, selectedParcelaColacor, afiacaoPaymentMethod,
    formasPagamentoOben, formasPagamentoColacor,
    deliveryOption, addresses, selectedAddress,
    notes, readyByDate, ordemCompra,
    companyProfiles, defaultProductionAssigneeId,
    getServicePrice, clearCart, toast,
  ]);

  // clearCustomer defined earlier (wraps useCustomerSelection.clearCustomer + clears cart/ordemCompra/userTools)



  return {
    // Auth
    authLoading, user, isStaff, isCustomerMode,
    // Customer
    customerSearch, setCustomerSearch, customers, selectedCustomer, searchingCustomers,
    loadingCustomer, customerUserId, selectCustomer, clearCustomer,
    // Products
    obenProducts, colacorProducts, productSearch, setProductSearch,
    loadingObenProducts, loadingColacorProducts,
    customerPricesOben, customerPricesColacor,
    filteredObenProducts, filteredColacorProducts,
    customerPurchaseHistory,
    // Services
    userTools, loadingTools, servicos, loadingServicos,
    addToolDialogOpen, setAddToolDialogOpen, creatingLocalProfile,
    toolCategories, getFilteredServicos,
    // Vendedor
    vendedorDivergencias, validatingVendedor,
    // Payment
    sortedFormasPagamentoOben, sortedFormasPagamentoColacor,
    selectedParcelaOben, setSelectedParcelaOben,
    selectedParcelaColacor, setSelectedParcelaColacor,
    loadingFormas, customerParcelaRankingOben, customerParcelaRankingColacor,
    afiacaoPaymentMethod, setAfiacaoPaymentMethod,
    volumesOben, volumesColacor,
    ordemCompra, setOrdemCompra,
    isOrdemCompraCustomer: requiresPo,
    // Delivery
    deliveryOption, setDeliveryOption, addresses, selectedAddress, setSelectedAddress,
    selectedTimeSlot, setSelectedTimeSlot, showAddressOptions, setShowAddressOptions,
    // Cart
    cart, notes, setNotes, submitting, activeTab, setActiveTab,
    readyByDate, setReadyByDate,
    productItems, obenProductItems, colacorProductItems, serviceItems, cartProductIds,
    availableTools,
    addProductToCart, addTintProductToCart, addServiceToCart,
    tintPendingProduct, setTintPendingProduct,
    updateServiceServico, updateServiceNotes, updateServicePhotos,
    updateQuantity, updateProductPrice, removeFromCart,
    getProductPrice, getServicePrice,
    // Totals
    obenSubtotal, colacorProdSubtotal, serviceSubtotal, totalEstimated,
    currentStep,
    // Handlers
    handleVoiceItemsIdentified, handleImageCategoryIdentified,
    handleAICustomerSelect, handleUnifiedAIResult,
    handleAddRecommendation, handleStaffAddTool,
    submitOrder, submitQuote, loadUserTools,
    // Order success
    orderSuccessOpen, setOrderSuccessOpen, lastOrderData,
    // Navigate
    navigate,
  };
}
