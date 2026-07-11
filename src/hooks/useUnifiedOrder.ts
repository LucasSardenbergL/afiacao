import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { OmieServico } from '@/services/omieService';
import { usePricingEngine } from '@/hooks/usePricingEngine';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import { useCart, VOLUME_UNITS } from '@/hooks/unifiedOrder/useCart';
import { useCustomerSelection } from '@/hooks/unifiedOrder/useCustomerSelection';
import { useProductCatalog } from '@/hooks/unifiedOrder/useProductCatalog';
import { useClienteTier, useTierPrecoConfig } from '@/hooks/useClienteTier';
import { precoPartida } from '@/lib/pricing/precoPartida';
import { submitOrder as submitOrderService, submitQuote as submitQuoteService } from '@/services/orderSubmission';
import type { LastOrderDataShape, BloqueioCreditoPedido } from '@/services/orderSubmission';
import { track } from '@/lib/analytics';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';
import { DeliveryOption } from '@/types';
import type { AIOrderResult, AICustomerMatch } from '@/components/UnifiedAIAssistant';
import type { IdentifiedItem } from '@/components/VoiceServiceInput';
import { logger } from '@/lib/logger';
import { maskDocument } from '@/lib/format';
import { buildOmieCustomer } from '@/lib/unified-order/build-omie-customer';
import { computeCheckoutFingerprint, decideCheckoutEnvelope, type CheckoutEnvelope } from '@/services/orderSubmission/checkout-envelope';
import { resolveBridgeMetadata } from '@/services/orderSubmission/origem';

const CHECKOUT_ENV_KEY = 'unified_order_checkout_env';
function loadCheckoutEnv(): CheckoutEnvelope | null {
  if (typeof localStorage === 'undefined') return null;
  try { const r = localStorage.getItem(CHECKOUT_ENV_KEY); return r ? JSON.parse(r) as CheckoutEnvelope : null; } catch { return null; }
}
function persistCheckoutEnv(e: CheckoutEnvelope | null) {
  if (typeof localStorage === 'undefined') return;
  try { if (e) localStorage.setItem(CHECKOUT_ENV_KEY, JSON.stringify(e)); else localStorage.removeItem(CHECKOUT_ENV_KEY); } catch { /* quota */ }
}

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
  const [searchParams] = useSearchParams();
  const { user, isStaff, loading: authLoading } = useAuth();

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
  // useMemo estabiliza a referência: `|| []` criava um array novo a cada render,
  // invalidando os useMemo/useCallback que dependem destes (sortedFormas*, submit).
  const formasPagamentoOben = useMemo(() => obenFormasQuery.data || [], [obenFormasQuery.data]);
  const formasPagamentoColacor = useMemo(() => colacorFormasQuery.data || [], [colacorFormasQuery.data]);
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
  // Guard re-entrante do submit por REF (não state): double-tap entre o clique
  // e o re-render do disabled veria a MESMA closure com submitting=false e
  // dispararia 2 fluxos completos (= 2 PVs cobrados no Omie).
  const submittingRef = useRef(false);
  // activeTab moved into useCart hook below
  const [readyByDate, setReadyByDate] = useState<string>('');
  const [defaultProductionAssigneeId, setDefaultProductionAssigneeId] = useState<string | null>(null);

  // Load default production assignee (configured via Governance > Settings).
  // Used to attribute auto-created Colacor production orders.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('get_default_production_assignee');
      if (!cancelled) setDefaultProductionAssigneeId((data as string | null) || null);
    })();
    return () => { cancelled = true; };
  }, []);
  
  // Order success dialog
  const [orderSuccessOpen, setOrderSuccessOpen] = useState(false);
  const [lastOrderData, setLastOrderData] = useState<LastOrderDataShape | null>(null);
  // Contas travadas pela trava de crédito no ÚLTIMO envio (Fase 2) — alimenta o
  // painel de bloqueio do dialog de resultado e o fluxo de exceção.
  const [bloqueiosCredito, setBloqueiosCredito] = useState<BloqueioCreditoPedido[]>([]);

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
    customerPricesOben,
    customerPricesColacor,
    customerPriceDatesOben,
    customerPriceDatesColacor,
    selectedParcelaOben, setSelectedParcelaOben,
    selectedParcelaColacor, setSelectedParcelaColacor,
    customerParcelaRankingOben,
    customerParcelaRankingColacor,
    addresses,
    selectedAddress, setSelectedAddress,
    customerPurchaseHistory,
    vendedorDivergencias, validatingVendedor,
    selectCustomer, clearCustomer: clearCustomerInternal,
    waitForAccountEnsure,
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

  // Tier do cliente (por conta) + multiplicador de partida — alimentam a precedência
  // de NASCIMENTO do preço (precoPartida). Falha/ausência → null → comportamento vigente.
  const { data: tierPorConta, isLoading: tierLoading } = useClienteTier(customerUserId);
  const { data: multConfig, isLoading: configLoading } = useTierPrecoConfig();
  // Enquanto tier/config carregam, o preço de partida ainda não é FIRME (adicionar antes
  // faria o item tier C nascer sem o mult, não-determinístico — Codex P1). O wizard gateia
  // o ADD por este sinal. Só espera de fato quando há cliente (tier depende dele).
  const precoPartidaLoading = configLoading || (!!customerUserId && tierLoading);

  // Pricing helpers (defined here so useCart can depend on them)
  const getProductPrice = useCallback((product: Product): number => {
    const account = (product.account || 'oben') as ProductAccount;
    const contaKey = account === 'colacor' ? 'colacor' : 'oben'; // wizard só vende oben/colacor
    const prices = contaKey === 'oben' ? customerPricesOben : customerPricesColacor;
    const datas = contaKey === 'oben' ? customerPriceDatesOben : customerPriceDatesColacor;
    const omiePrice = prices[product.omie_codigo_produto];
    const tier = tierPorConta?.[contaKey] ?? null;
    const mult = tier ? (multConfig?.[contaKey]?.[tier] ?? null) : null;
    // Precedência de nascimento (spec §4): último praticado ≤180d > tabela×mult(tier) > tabela.
    return precoPartida({
      tabela: product.valor_unitario,
      ultimoPraticado: omiePrice && omiePrice > 0 ? omiePrice : null,
      ultimoPraticadoEm: datas[product.omie_codigo_produto] ?? null,
      hoje: new Date(),
      tier,
      mult,
    });
  }, [
    customerPricesOben, customerPricesColacor,
    customerPriceDatesOben, customerPriceDatesColacor,
    tierPorConta, multConfig,
  ]);

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

  // Reprecificação da FRONTEIRA (Codex P1-A): um item de produto comum pode nascer ANTES de
  // tier/mult firmarem — por QUALQUER via (lista, IA, recomendação, deep-link), não só a lista.
  // Quando o preço de partida fica firme, corrige os itens que o vendedor NÃO editou
  // (unit_price === precoNascimento). Idempotente: roda sobre a TABELA (getProductPrice), nunca
  // sobre o preço já no carrinho — se já está certo, devolve o mesmo valor e nada muda. Tint e
  // preço fixado pela IA ficam de fora (precoNascimento ausente).
  useEffect(() => {
    if (precoPartidaLoading) return;
    setCart(prev => {
      let mudou = false;
      const next = prev.map(c => {
        if (c.type !== 'product') return c;
        const p = c as ProductCartItem;
        if (p.tint_formula_id || p.precoNascimento == null) return c;
        if (p.unit_price !== p.precoNascimento) return c; // vendedor editou → não toca
        const novo = getProductPrice(p.product);
        if (novo === p.unit_price) return c;
        mudou = true;
        return { ...p, unit_price: novo, precoNascimento: novo };
      });
      return mudou ? next : prev;
    });
  }, [precoPartidaLoading, getProductPrice, setCart]);

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
  } = catalog;

  // Idempotência: envelope {checkout_id, fingerprint, committed} durável (refresh).
  // A fp amarra o checkout ao pedido; reseta só no clearCustomer e no sucesso TOTAL.
  const checkoutEnvRef = useRef<CheckoutEnvelope | null>(loadCheckoutEnv());

  // Wrap clearCustomer to also clear cart + ordem de compra
  const clearCustomer = useCallback(() => {
    clearCustomerInternal();
    setCart([]);
    setOrdemCompra('');
    checkoutEnvRef.current = null; persistCheckoutEnv(null);
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
  }, [isStaff, loadDefaultPrices]);

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
    // Setup run-once ao entrar em modo cliente: o guard (selectedCustomer) + a natureza
    // mount-on-condition tornam intencional a omissão de loadDefaultPrices/loadPriceHistory/
    // selectedCustomer/setters. Incluí-los re-dispararia o fetch assíncrono de perfil até assentar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      toast.success('Ferramentas já adicionadas', { description: 'Todas as ferramentas identificadas já estão no pedido.' });
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
        toast.success('Ferramenta encontrada!', { description: `${addedCount} ferramenta(s) adicionada(s) ao pedido` });
      }
    } else {
      toast.error('Ferramenta não cadastrada', { description: 'Nenhuma ferramenta dessa categoria foi encontrada no cadastro.' });
    }
  };

  // AI Customer handler
  const handleAICustomerSelect = useCallback(async (customer: AICustomerMatch) => {
    // P0-B (item 3): NÃO confiar no codigo_cliente da IA — analyze não emite mais código cross-conta, e
    // mesmo que emitisse seria do espelho parcial (colacor rotulado como oben). Resolve sempre por
    // (user_id, empresa_omie) ou documento; a identidade autoritativa é derivada no edge de qualquer forma.
    let codigoCliente: number | null = null;
    if (customer.user_id) {
      // Money-path (P0-A): codigoCliente vira OmieCustomer.codigo_cliente (código da conta OBEN).
      // Filtrar empresa_omie='oben' impede pegar o código de OUTRA conta do espelho e mandá-lo ao
      // Omie oben (cliente errado). Sem oben no espelho → cai no fallback por documento (API oben).
      const { data: omieMapping } = await supabase
        .from('omie_clientes').select('omie_codigo_cliente')
        .eq('user_id', customer.user_id).eq('empresa_omie', 'oben').maybeSingle();
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

  // Pré-seleção por user_id (deep-link "Novo pedido" do Customer 360).
  // Busca identidade (profiles) + mapeamento Omie (omie_clientes) por user_id,
  // monta o OmieCustomer e reusa o selectCustomer existente. Falha → silencioso
  // (não pré-seleciona; o vendedor escolhe no passo Cliente).
  // Money-path (P0-A): o código vira OmieCustomer.codigo_cliente, tratado como o código da conta
  // OBEN pelo submitOrder. omie_clientes tem código por conta (UNIQUE user_id+empresa_omie); filtrar
  // empresa_omie='oben' impede pegar o código de OUTRA conta (ex.: colacor) e mandá-lo ao Omie oben
  // (cliente errado). Sem código oben → codigo_cliente=0 → o preflight bloqueia (fail-closed).
  const selectCustomerByUserId = useCallback(async (userId: string) => {
    if (!userId) return;
    try {
      const [{ data: profile }, { data: omie }] = await Promise.all([
        supabase.from('profiles')
          .select('razao_social, name, document')
          .eq('user_id', userId).maybeSingle(),
        supabase.from('omie_clientes')
          .select('omie_codigo_cliente, omie_codigo_vendedor')
          .eq('user_id', userId).eq('empresa_omie', 'oben').maybeSingle(),
      ]);
      const omieCustomer = buildOmieCustomer(userId, profile, omie);
      if (omieCustomer) await selectCustomer(omieCustomer);
    } catch {
      // fallback silencioso: mantém o fluxo manual intacto
    }
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
        const usouTabela = !(aiPrice && aiPrice > 0);
        const unitPrice = usouTabela ? getProductPrice(product as Product) : aiPrice;
        newCartItems.push({
          type: 'product', product: product as Product, quantity: aiProd.quantity, unit_price: unitPrice, account,
          // só marca p/ reprecificação se nasceu da tabela/tier (não do preço que a IA fixou)
          ...(usouTabela ? { precoNascimento: unitPrice } : {}),
        });
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
  }, [obenProducts, colacorProducts, userTools, servicos, cart, getProductPrice, setCart]);

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
  }, [obenProducts, colacorProducts, addProductToCart]);

  // Create local profile
  const handleStaffAddTool = async () => {
    if (!selectedCustomer) return;
    if (customerUserId) { setAddToolDialogOpen(true); return; }
    setCreatingLocalProfile(true);
    try {
      // #11 (P0-B-bis PR-4): resolve codigo->user_id pela view fresca account=oben. selectedCustomer.codigo_cliente
      // é o código da conta OBEN; buscá-lo no espelho poluído SEM conta pegava o user ERRADO em colisão de código
      // entre contas (Codex P2 — anexa a ferramenta ao cliente errado). A fresca é UNIQUE(omie_codigo_cliente,
      // account) → resolve o user certo; miss (ausente/stale 7d) cai no fallback por documento abaixo (fail-closed).
      const { data: existingMapping } = await supabase
        .from('omie_customer_account_map_fresco').select('user_id')
        .eq('omie_codigo_cliente', selectedCustomer.codigo_cliente).eq('account', 'oben').maybeSingle();
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
      toast.success('Perfil criado', { description: 'Agora cadastre as ferramentas.' });
      setAddToolDialogOpen(true);
    } catch (e) {
      logger.error('Failed to prepare local profile for staff add-tool flow', {
        mode: 'staff',
        stage: 'create_local_profile',
        customerCnpjCpf: maskDocument(selectedCustomer.cnpj_cpf),
        codigoCliente: selectedCustomer.codigo_cliente,
        error: e,
      });
      toast.error('Erro', { description: 'Não foi possível preparar o cadastro.' });
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
        toast.success('Orçamento salvo', { description: result.results.join(' | ') });
        clearCart();
        setNotes('');
        navigate('/sales/quotes');
      } else {
        toast.error('Erro ao salvar orçamento', {
          description: result.errors[0]?.message || 'Falha desconhecida',
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedCustomer, cart.length, user, customerUserId,
    obenProductItems, colacorProductItems, obenSubtotal, colacorProdSubtotal,
    deliveryOption, addresses, selectedAddress, notes,
    clearCart, navigate,
  ]);

  const submitOrder = useCallback(async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    // Seleção em andamento: o ensure desta seleção ainda nem foi retido (a ref
    // tem a promise placeholder) — o preflight fail-closed do service já
    // bloquearia, mas barrar aqui dá feedback melhor que o erro do preflight.
    if (loadingCustomer) {
      toast.info('Aguarde — ainda carregando os dados do cliente.');
      return;
    }
    if (submittingRef.current) return; // re-entrância: ver comentário na declaração
    submittingRef.current = true;
    setSubmitting(true);
    // Impressão digital do pedido de produto (oben+colacor) + cliente.
    const customerKey = String(selectedCustomer.local_user_id || selectedCustomer.codigo_cliente || '');
    const fpItems = [
      ...obenProductItems.map(c => ({ account: 'oben', omie_codigo_produto: c.product.omie_codigo_produto, quantity: c.quantity, unit_price: c.unit_price })),
      ...colacorProductItems.map(c => ({ account: 'colacor', omie_codigo_produto: c.product.omie_codigo_produto, quantity: c.quantity, unit_price: c.unit_price })),
    ];
    const fingerprint = computeCheckoutFingerprint(customerKey, fpItems);
    const decision = decideCheckoutEnvelope(checkoutEnvRef.current, fingerprint);
    if (decision === 'conflict') {
      setSubmitting(false);
      toast.error('Há um envio pendente para este cliente com outro carrinho', {
        description: 'Reenvie o pedido pendente (mesmo carrinho) ou limpe o cliente para começar um novo.',
      });
      return;
    }
    if (decision === 'new') {
      // CONGELA a metadata da ponte UMA VEZ, na criação do envelope. Anti-troca-de-cliente:
      // a navegação SPA muda os query params sem remontar o estado do pedido, então uma ligação
      // ENTRANTE de B durante o pedido de A NÃO pode herdar origem/atendimento de A. O helper só
      // aplica a metadata da ligação quando ?customer== o cliente realmente selecionado; o submit
      // lê SEMPRE do envelope abaixo, nunca da URL ao vivo.
      const bridge = resolveBridgeMetadata({
        urlCustomer: searchParams.get('customer'),
        selectedCustomerUserId: customerUserId,
        urlOrigem: searchParams.get('origem'),
        urlAtendimento: searchParams.get('atendimento'),
        isCustomerMode,
      });
      checkoutEnvRef.current = {
        checkoutId: crypto.randomUUID(), fingerprint, committed: true,
        customerUserId: customerUserId ?? null,
        origem: bridge.origem,
        atendimentoId: bridge.atendimentoId,
      };
    } else {
      // reuse: mantém o MESMO checkoutId E a metadata da ponte CONGELADA na criação (não
      // re-capturar da URL — o spread preserva origem/atendimento/customerUserId originais).
      // commit trava a fp (editar o carrinho depois = conflito).
      checkoutEnvRef.current = { ...checkoutEnvRef.current, committed: true } as CheckoutEnvelope;
    }
    persistCheckoutEnv(checkoutEnvRef.current);
    const checkoutId = checkoutEnvRef.current.checkoutId;
    try {
      // Etapa 3 (spec preco-realtime): a seleção dispara o auto-cadastro em
      // BACKGROUND; o join é AQUI — garante os códigos por-conta antes do
      // envio, sem segurar o spinner da seleção. O retorno é o cliente
      // PÓS-ensure DA SELEÇÃO CORRENTE (token-stamp; null se a retenção é de
      // outra seleção) — a closure de selectedCustomer pode ser a cópia
      // anterior aos códigos criados. O preflight fail-closed do
      // submitOrderService segue como rede pra conta sem identidade.
      const ensuredCustomer = await waitForAccountEnsure();
      const effectiveCustomer = ensuredCustomer ?? selectedCustomer;
      const result = await submitOrderService({
        customer: effectiveCustomer,
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
        isCustomerMode,
        checkoutId,
        // Lê do ENVELOPE congelado (nunca da URL ao vivo). Fallback defensivo p/ envelopes
        // legados (criados antes desta fase, sem os campos da ponte).
        origem: checkoutEnvRef.current.origem ?? (isCustomerMode ? 'web_customer' : 'web_staff'),
        atendimentoId: checkoutEnvRef.current.atendimentoId ?? null,
      });
      if (result.success && result.lastOrderData) {
        setLastOrderData(result.lastOrderData);
        setOrderSuccessOpen(true);
        const bloqueios = result.bloqueiosCredito ?? [];
        setBloqueiosCredito(bloqueios);
        for (const b of bloqueios) {
          track('venda.bloqueio_credito_exibido', {
            account: b.account, vencido: b.vencido, titulos: b.titulos,
          });
        }
        if (result.allConfirmed) {
          clearCart();
          setNotes('');
          checkoutEnvRef.current = null; persistCheckoutEnv(null); // sucesso TOTAL → próximo pedido = novo envelope
        } else if (bloqueios.length > 0) {
          // Trava de crédito: mensagem específica — "parcialmente enviado" esconderia a causa.
          toast.warning('Envio bloqueado por crédito', {
            description: 'O PV não foi criado no Omie. Um gestor pode aprovar uma exceção para este pedido — depois é só reenviar.',
          });
        } else {
          // Sucesso PARCIAL: NÃO limpar o carrinho nem resetar o envelope — o retry (mesma fp)
          // reusa a MESMA linha/chave e não duplica a conta de PRODUTO já enviada.
          toast.warning('Pedido parcialmente enviado', {
            description: serviceItems.length > 0
              ? 'Os produtos não duplicam no reenvio. Atenção: a OS de afiação pode duplicar — confira no Omie.'
              : 'Alguma conta ficou pendente no ERP. Reenvie — os produtos não duplicam.',
          });
        }
        // Avisos não-bloqueio: "criado com avisos". Bloqueio de crédito fica FORA deste
        // toast de sucesso (o PV não foi criado — dizê-lo "criado" seria mentira).
        const avisos = result.errors.filter(e => !e.step.startsWith('bloqueio_credito'));
        if (avisos.length > 0) {
          toast.success('Pedido criado com avisos', {
            description: avisos.map(e => e.message).join(' | '),
          });
        }
      } else {
        toast.error('Erro ao criar pedido', {
          description: result.errors[0]?.message || 'Falha desconhecida',
        });
      }
    } catch (error) {
      toast.error('Erro ao criar pedido', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      submittingRef.current = false;
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
    getServicePrice, clearCart, isCustomerMode,
    waitForAccountEnsure, loadingCustomer, searchParams,
  ]);

  // clearCustomer defined earlier (wraps useCustomerSelection.clearCustomer + clears cart/ordemCompra/userTools)



  return {
    // Auth
    authLoading, user, isStaff, isCustomerMode,
    // Customer
    customerSearch, setCustomerSearch, customers, selectedCustomer, searchingCustomers,
    loadingCustomer, customerUserId, selectCustomer, selectCustomerByUserId, clearCustomer,
    // Products
    obenProducts, colacorProducts, productSearch, setProductSearch,
    loadingObenProducts, loadingColacorProducts,
    customerPricesOben, customerPricesColacor,
    filteredObenProducts, filteredColacorProducts,
    customerPurchaseHistory,
    precoPartidaLoading,
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
    cart, setCart, notes, setNotes, submitting, activeTab, setActiveTab,
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
    orderSuccessOpen, setOrderSuccessOpen, lastOrderData, bloqueiosCredito,
    // Navigate
    navigate,
  };
}
