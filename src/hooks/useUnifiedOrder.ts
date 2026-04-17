import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { syncOrderToOmie, OmieServico } from '@/services/omieService';
import { usePricingEngine } from '@/hooks/usePricingEngine';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import { useCart, VOLUME_UNITS } from '@/hooks/unifiedOrder/useCart';
import { useCustomerSelection } from '@/hooks/unifiedOrder/useCustomerSelection';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';
import { DELIVERY_FEES, DeliveryOption } from '@/types';
import type { AIOrderResult, AICustomerMatch } from '@/components/UnifiedAIAssistant';
import type { IdentifiedItem } from '@/components/VoiceServiceInput';

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

  // Customer
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<OmieCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<OmieCustomer | null>(null);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [loadingCustomer, setLoadingCustomer] = useState(false);
  const [customerUserId, setCustomerUserId] = useState<string | null>(null);
  const [requiresPo, setRequiresPo] = useState<boolean>(false);
  const [companyProfiles, setCompanyProfiles] = useState<Record<string, CompanyProfile>>({});

  // Products by account
  const [obenProducts, setObenProducts] = useState<Product[]>([]);
  const [colacorProducts, setColacorProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [loadingObenProducts, setLoadingObenProducts] = useState(true);
  const [loadingColacorProducts, setLoadingColacorProducts] = useState(true);
  const [customerPricesOben, setCustomerPricesOben] = useState<Record<number, number>>({});
  const [customerPricesColacor, setCustomerPricesColacor] = useState<Record<number, number>>({});

  // Afiação
  const [userTools, setUserTools] = useState<UserTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [servicos, setServicos] = useState<OmieServico[]>([]);
  const [loadingServicos, setLoadingServicos] = useState(true);
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);
  const [creatingLocalProfile, setCreatingLocalProfile] = useState(false);
  const [toolCategories, setToolCategories] = useState<ToolCategory[]>([]);

  // Vendedor validation
  const [vendedorDivergencias, setVendedorDivergencias] = useState<string[]>([]);
  const [validatingVendedor, setValidatingVendedor] = useState(false);

  // Payment
  const [formasPagamentoOben, setFormasPagamentoOben] = useState<FormaPagamento[]>([]);
  const [formasPagamentoColacor, setFormasPagamentoColacor] = useState<FormaPagamento[]>([]);
  const [selectedParcelaOben, setSelectedParcelaOben] = useState<string>('999');
  const [selectedParcelaColacor, setSelectedParcelaColacor] = useState<string>('999');
  const [loadingFormas, setLoadingFormas] = useState(false);
  // Auto-calculated volumes (no manual input needed)
  const [ordemCompra, setOrdemCompra] = useState<string>('');
  const [customerParcelaRankingOben, setCustomerParcelaRankingOben] = useState<string[]>([]);
  const [customerParcelaRankingColacor, setCustomerParcelaRankingColacor] = useState<string[]>([]);
  const [afiacaoPaymentMethod, setAfiacaoPaymentMethod] = useState<string>('a_vista');
  // Customer purchase history: product codigo -> last order date
  const [customerPurchaseHistory, setCustomerPurchaseHistory] = useState<Record<string, string>>({});

  // Delivery
  const [deliveryOption, setDeliveryOption] = useState<DeliveryOption>('coleta_entrega');
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string>('');
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
  const [lastOrderData, setLastOrderData] = useState<{
    customerName: string;
    customerDocument: string;
    items: Array<{ description: string; quantity: number; unitPrice: number; codigo?: string; unidade?: string; tintCorId?: string; tintNomeCor?: string }>;
    total: number;
    orderNumbers: string[];
    printDataList: Array<import('@/components/OrderPrintLayout').PrintOrderData>;
  } | null>(null);

  // Pricing
  const { loadDefaultPrices, calculatePrice } = usePricingEngine();
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

  // Staff: load all catalogs
  useEffect(() => {
    if (isStaff) {
      // Load products in parallel but stock sync will be serialized
      loadProductsForAccount('oben');
      loadProductsForAccount('colacor');
      loadFormasPagamento('oben');
      loadFormasPagamento('colacor');
      loadServicosColacor();
      loadDefaultPrices();
      loadCategories();
      loadCompanyProfiles();
    }
  }, [isStaff]);

  // Customer: auto-setup own context (skip customer search)
  useEffect(() => {
    if (!isCustomerMode || !user || selectedCustomer) return;
    // Load services catalog and tools for the logged-in customer
    loadServicosColacor();
    loadDefaultPrices();
    loadCategories();
    setCustomerUserId(user.id);
    loadUserTools(user.id);
    loadAddresses(user.id);
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
        console.error('Erro ao carregar perfil do cliente:', err);
      }
    })();
  }, [isCustomerMode, user]);

  // Customer search
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

  const loadProductsForAccount = async (account: ProductAccount) => {
    const setLoading = account === 'oben' ? setLoadingObenProducts : setLoadingColacorProducts;
    const setProds = account === 'oben' ? setObenProducts : setColacorProducts;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type, metadata')
        .eq('account', account)
        .not('familia', 'ilike', '%imobilizado%')
        .not('familia', 'ilike', '%uso e consumo%')
        .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
        .not('familia', 'ilike', '%jumbos de lixa para discos%')
        .not('familia', 'ilike', 'jumbo%')
        .not('familia', 'ilike', '%material para tingimix%')
        .order('descricao');
      if (!data || data.length === 0) {
        try {
          let nextPage: number | null = 1;
          while (nextPage) {
            const { data: syncResult, error: syncError } = await supabase.functions.invoke('omie-vendas-sync', {
              body: { action: 'sync_products', start_page: nextPage, account },
            });
            if (syncError) throw syncError;
            nextPage = syncResult.nextPage || null;
          }
          const { data: refreshed } = await supabase
            .from('omie_products')
            .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type, metadata')
            .eq('account', account)
            .not('familia', 'ilike', '%imobilizado%')
            .not('familia', 'ilike', '%uso e consumo%')
            .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
            .not('familia', 'ilike', '%jumbos de lixa para discos%')
            .not('familia', 'ilike', 'jumbo%')
            .not('familia', 'ilike', '%material para tingimix%')
            .order('descricao');
          setProds((refreshed || []) as Product[]);
        } catch (syncErr) { console.error('Sync error:', syncErr); }
      } else {
        setProds(data as Product[]);
      }
      syncStockInBackground(account, setProds);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  // Serialize stock syncs to avoid Omie rate limits
  const stockSyncQueue = useRef<Promise<void>>(Promise.resolve());

  const syncStockInBackground = (account: ProductAccount, setProds: React.Dispatch<React.SetStateAction<Product[]>>) => {
    stockSyncQueue.current = stockSyncQueue.current.then(async () => {
      try {
        let nextPage: number | null = 1;
        while (nextPage) {
          const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
            body: { action: 'sync_estoque', start_page: nextPage, account },
          });
          if (error) break;
          nextPage = data?.nextPage || null;
        }
        const { data: refreshed } = await supabase
          .from('omie_products')
          .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type, metadata')
          .eq('account', account)
          .not('familia', 'ilike', '%imobilizado%')
          .not('familia', 'ilike', '%uso e consumo%')
          .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
          .not('familia', 'ilike', '%jumbos de lixa para discos%')
          .not('familia', 'ilike', 'jumbo%')
          .not('familia', 'ilike', '%material para tingimix%')
          .order('descricao');
        if (refreshed) setProds(refreshed as Product[]);
      } catch (e) { console.error(`Background stock sync error (${account}):`, e); }
    });
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

  const loadCompanyProfiles = async () => {
    try {
      const { data } = await supabase
        .from('company_profiles')
        .select('account, legal_name, cnpj, phone, address');
      if (data) {
        const map: Record<string, CompanyProfile> = {};
        for (const row of data) map[row.account] = row as CompanyProfile;
        setCompanyProfiles(map);
      }
    } catch (e) { console.error('Error loading company profiles', e); }
  };

  const loadFormasPagamento = async (account: ProductAccount) => {
    setLoadingFormas(true);
    try {
      const { data } = await supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'listar_formas_pagamento', account },
      });
      if (data?.formas) {
        if (account === 'oben') setFormasPagamentoOben(data.formas);
        else setFormasPagamentoColacor(data.formas);
      }
    } catch (e) { console.error(e); }
    finally { setLoadingFormas(false); }
  };

  const loadCategories = async () => {
    try {
      const { data } = await supabase
        .from('tool_categories')
        .select('id, name, description, suggested_interval_days')
        .order('name');
      if (data) setToolCategories(data);
    } catch (e) { console.error('Erro ao carregar categorias:', e); }
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

  const loadAddresses = async (userId: string) => {
    try {
      const { data } = await supabase
        .from('addresses')
        .select('*')
        .eq('user_id', userId)
        .order('is_default', { ascending: false });
      if (data && data.length > 0) {
        const formatted: AddressData[] = data.map(addr => ({
          id: addr.id, label: addr.label, street: addr.street, number: addr.number,
          complement: addr.complement, neighborhood: addr.neighborhood, city: addr.city,
          state: addr.state, zipCode: addr.zip_code,
        }));
        setAddresses(formatted);
        setSelectedAddress(formatted[0].id);
      }
    } catch (e) { console.error(e); }
  };

  const selectCustomer = async (cust: OmieCustomer) => {
    setLoadingCustomer(true);
    setCustomerSearch('');
    setCustomers([]);
    setCart([]);
    setVendedorDivergencias([]);
    setAddresses([]);
    setSelectedAddress('');
    setCustomerPurchaseHistory({});
    setRequiresPo(false);
    try {
      setSelectedCustomer(cust);
      let localUserId = cust.local_user_id || null;
      if (!localUserId) {
        const { data: mapping } = await supabase
          .from('omie_clientes')
          .select('user_id')
          .eq('omie_codigo_cliente', cust.codigo_cliente)
          .maybeSingle();
        if (mapping?.user_id) localUserId = mapping.user_id;
      }
      if (!localUserId && cust.cnpj_cpf) {
        const docClean = cust.cnpj_cpf.replace(/\D/g, '');
        if (docClean.length >= 11) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('user_id, requires_po')
            .or(`document.eq.${docClean},document.eq.${cust.cnpj_cpf}`)
            .limit(1)
            .maybeSingle();
          if (profile?.user_id) localUserId = profile.user_id;
          if (profile?.requires_po) setRequiresPo(true);
        }
      }
      // If we have a localUserId but didn't fetch requires_po above, fetch it now
      if (localUserId) {
        const { data: poProfile } = await supabase
          .from('profiles')
          .select('requires_po')
          .eq('user_id', localUserId)
          .maybeSingle();
        if (poProfile?.requires_po) setRequiresPo(true);
      }
      if (localUserId) {
        setCustomerUserId(localUserId);
        loadUserTools(localUserId);
        loadAddresses(localUserId);
        loadPriceHistory();
        // Fetch local purchase history
        Promise.all([
          supabase.from('sales_orders')
            .select('items, created_at')
            .eq('customer_user_id', localUserId)
            .neq('status', 'orcamento')
            .order('created_at', { ascending: false })
            .limit(100),
          supabase.from('sales_price_history')
            .select('product_id, created_at')
            .eq('customer_user_id', localUserId)
            .order('created_at', { ascending: false }),
        ]).then(([ordersRes, priceHistRes]) => {
          const history: Record<string, string> = {};
          if (ordersRes.data) {
            for (const order of ordersRes.data) {
              const items = order.items as any[];
              if (Array.isArray(items)) {
                for (const item of items) {
                  const code = item.codigo || item.product_code || '';
                  if (code && !history[code]) history[code] = order.created_at;
                  const pid = item.product_id || '';
                  if (pid && !history[`pid:${pid}`]) history[`pid:${pid}`] = order.created_at;
                }
              }
            }
          }
          if (priceHistRes.data) {
            for (const row of priceHistRes.data) {
              if (!history[`pid:${row.product_id}`]) history[`pid:${row.product_id}`] = row.created_at;
            }
          }
          setCustomerPurchaseHistory(prev => ({ ...prev, ...history }));
        });
      }

      const settledResults = await Promise.allSettled([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_precos_cliente', codigo_cliente: cust.codigo_cliente, account: 'oben' },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_precos_cliente', codigo_cliente: cust.codigo_cliente, account: 'colacor' },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente, account: 'oben' },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente, account: 'colacor' },
        }),
        localUserId
          ? supabase.from('sales_price_history').select('product_id, unit_price, created_at')
              .eq('customer_user_id', localUserId).order('created_at', { ascending: false })
          : Promise.resolve({ data: null }),
        cust.cnpj_cpf
          ? supabase.functions.invoke('omie-vendas-sync', {
              body: { action: 'buscar_cliente', document: cust.cnpj_cpf, account: 'colacor' },
            })
          : Promise.resolve({ data: null }),
        cust.cnpj_cpf
          ? supabase.functions.invoke('omie-sync', {
              body: { action: 'buscar_cliente_por_documento', document: cust.cnpj_cpf },
            })
          : Promise.resolve({ data: null }),
      ]);

      const labels = [
        'preços Oben',
        'preços Colacor',
        'última parcela Oben',
        'última parcela Colacor',
        'histórico de preço local',
        'cliente Colacor',
        'cliente Afiação',
      ];
      const failedParts: string[] = [];
      const getResult = (idx: number): any => {
        const r = settledResults[idx];
        if (r.status === 'fulfilled') {
          const val: any = r.value;
          if (val && val.error) {
            console.error(`[selectCustomer] ${labels[idx]} retornou erro:`, val.error?.message || val.error);
            failedParts.push(labels[idx]);
            return { data: null };
          }
          return val ?? { data: null };
        }
        console.error(`[selectCustomer] ${labels[idx]} falhou:`, r.reason?.message || r.reason);
        failedParts.push(labels[idx]);
        return { data: null };
      };

      const priceOben = getResult(0);
      const priceColacor = getResult(1);
      const parcelaOben = getResult(2);
      const parcelaColacor = getResult(3);
      const localPriceResult = getResult(4);
      const colacorClientResult = getResult(5);
      const afiacaoClientResult = getResult(6);

      if (failedParts.length > 0) {
        toast({
          title: 'Alguns dados do cliente não foram carregados',
          description: `Falharam: ${failedParts.join(', ')}. Você pode continuar, mas preços/parcelas podem não refletir o contrato.`,
        });
      }

      if (colacorClientResult?.data?.cliente) {
        cust.codigo_cliente_colacor = colacorClientResult.data.cliente.codigo_cliente;
        cust.codigo_vendedor_colacor = colacorClientResult.data.cliente.codigo_vendedor || null;
      }
      if (afiacaoClientResult?.data?.codigo_cliente) {
        cust.codigo_cliente_afiacao = afiacaoClientResult.data.codigo_cliente;
        cust.codigo_vendedor_afiacao = afiacaoClientResult.data.codigo_vendedor || null;
      }

      // Auto-create customer in accounts where they don't exist yet
      const customerPayload = {
        document: cust.cnpj_cpf,
        razao_social: cust.razao_social,
        nome_fantasia: cust.nome_fantasia,
        endereco: cust.endereco,
        endereco_numero: cust.endereco_numero,
        bairro: cust.bairro,
        cidade: cust.cidade,
        estado: cust.estado,
        cep: cust.cep,
        telefone: cust.telefone,
        contato: cust.contato,
      };

      const autoCreatePromises: Promise<any>[] = [];

      if (!cust.codigo_cliente_colacor && cust.cnpj_cpf) {
        autoCreatePromises.push(
          supabase.functions.invoke('omie-vendas-sync', {
            body: { action: 'criar_cliente', account: 'colacor', ...customerPayload },
          }).then(res => {
            if (res.data?.codigo_cliente) {
              cust.codigo_cliente_colacor = res.data.codigo_cliente;
              cust.codigo_vendedor_colacor = res.data.codigo_vendedor || null;
              console.log(`[AutoCreate] Cliente criado na Colacor Vendas: ${res.data.codigo_cliente}`);
            }
          }).catch(e => console.warn('[AutoCreate] Erro ao criar na Colacor Vendas:', e))
        );
      }

      if (!cust.codigo_cliente_afiacao && cust.cnpj_cpf) {
        autoCreatePromises.push(
          supabase.functions.invoke('omie-sync', {
            body: { action: 'criar_cliente_afiacao', ...customerPayload },
          }).then(res => {
            if (res.data?.codigo_cliente) {
              cust.codigo_cliente_afiacao = res.data.codigo_cliente;
              cust.codigo_vendedor_afiacao = res.data.codigo_vendedor || null;
              console.log(`[AutoCreate] Cliente criado na Colacor Afiação: ${res.data.codigo_cliente}`);
            }
          }).catch(e => console.warn('[AutoCreate] Erro ao criar na Colacor Afiação:', e))
        );
      }

      if (autoCreatePromises.length > 0) {
        await Promise.all(autoCreatePromises);
      }

      setSelectedCustomer({ ...cust });

      // Save customer segment/tags to DB in background
      if (cust.codigo_cliente && (cust.tags?.length || cust.atividade)) {
        supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'salvar_segmento_cliente',
            codigo_cliente: cust.codigo_cliente,
            account: 'oben',
            tags: cust.tags || [],
            atividade: cust.atividade || '',
          },
        }).catch(() => {});
      }

      // Fetch Omie order history (runs in background, merges into purchase history + saves preferred items)
      const omieHistoryPromises: Promise<any>[] = [];
      if (cust.codigo_cliente) {
        omieHistoryPromises.push(
          supabase.functions.invoke('omie-vendas-sync', {
            body: { action: 'historico_produtos_cliente', codigo_cliente: cust.codigo_cliente, account: 'oben' },
          })
        );
      }
      if (cust.codigo_cliente_colacor) {
        omieHistoryPromises.push(
          supabase.functions.invoke('omie-vendas-sync', {
            body: { action: 'historico_produtos_cliente', codigo_cliente: cust.codigo_cliente_colacor, account: 'colacor' },
          })
        );
      }
      if (omieHistoryPromises.length > 0) {
        Promise.all(omieHistoryPromises).then((results) => {
          const omieHistory: Record<string, string> = {};
          for (const res of results) {
            if (res?.data?.history) {
              const h = res.data.history as Record<string, string>;
              for (const [omieCod, dateStr] of Object.entries(h)) {
                if (!omieHistory[`omie:${omieCod}`]) {
                  omieHistory[`omie:${omieCod}`] = dateStr;
                }
              }
            }
          }
          if (Object.keys(omieHistory).length > 0) {
            setCustomerPurchaseHistory(prev => ({ ...prev, ...omieHistory }));
          }
        });
      }

      const localPricesByProduct: Record<string, number> = {};
      if (localPriceResult.data && localPriceResult.data.length > 0) {
        for (const row of localPriceResult.data) {
          if (!localPricesByProduct[row.product_id]) {
            localPricesByProduct[row.product_id] = row.unit_price;
          }
        }
      }

      let localPricesByOmie: Record<number, number> = {};
      const productIds = Object.keys(localPricesByProduct);
      if (productIds.length > 0) {
        const { data: productMappings } = await supabase
          .from('omie_products').select('id, omie_codigo_produto').in('id', productIds);
        if (productMappings) {
          for (const pm of productMappings) {
            const price = localPricesByProduct[pm.id];
            if (price && price > 0) localPricesByOmie[pm.omie_codigo_produto] = price;
          }
        }
      }

      const mergedOben: Record<number, number> = { ...localPricesByOmie };
      if (priceOben.data?.precos) {
        for (const [k, v] of Object.entries(priceOben.data.precos as Record<string, number>)) {
          if (v && v > 0) mergedOben[Number(k)] = v;
        }
      }
      setCustomerPricesOben(mergedOben);

      const mergedColacor: Record<number, number> = { ...localPricesByOmie };
      if (priceColacor.data?.precos) {
        for (const [k, v] of Object.entries(priceColacor.data.precos as Record<string, number>)) {
          if (v && v > 0) mergedColacor[Number(k)] = v;
        }
      }
      setCustomerPricesColacor(mergedColacor);

      if (parcelaOben.data?.ultima_parcela) setSelectedParcelaOben(parcelaOben.data.ultima_parcela);
      if (parcelaOben.data?.parcela_ranking) setCustomerParcelaRankingOben(parcelaOben.data.parcela_ranking.map((r: any) => r.codigo));
      if (parcelaColacor.data?.ultima_parcela) setSelectedParcelaColacor(parcelaColacor.data.ultima_parcela);
      if (parcelaColacor.data?.parcela_ranking) setCustomerParcelaRankingColacor(parcelaColacor.data.parcela_ranking.map((r: any) => r.codigo));
    } catch (error: any) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    } finally {
      setLoadingCustomer(false);
    }

    if (cust.cnpj_cpf) {
      setValidatingVendedor(true);
      try {
        const { data: validacao, error } = await supabase.functions.invoke('omie-cliente', {
          body: { action: 'validar_vendedor', cnpj_cpf: cust.cnpj_cpf },
        });
        if (!error && validacao && !validacao.consistente) {
          setVendedorDivergencias(validacao.divergencias || []);
        }
      } catch (err) {
        console.error('Erro ao validar vendedor:', err);
      } finally {
        setValidatingVendedor(false);
      }
    }
  };

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
    if (!codigoCliente && (customer as any).user_id) {
      const { data: omieMapping } = await supabase
        .from('omie_clientes').select('omie_codigo_cliente')
        .eq('user_id', (customer as any).user_id).maybeSingle();
      if (omieMapping?.omie_codigo_cliente) codigoCliente = omieMapping.omie_codigo_cliente;
    }
    if (!codigoCliente && customer.cnpj_cpf) {
      try {
        const { data: omieResult } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_cliente', document: customer.cnpj_cpf, account: 'oben' },
        });
        if (omieResult?.codigo_cliente) codigoCliente = omieResult.codigo_cliente;
      } catch (e) { console.error('Error resolving customer via omie:', e); }
    }
    const omieCustomer: OmieCustomer = {
      codigo_cliente: codigoCliente || 0,
      razao_social: customer.razao_social,
      nome_fantasia: customer.nome_fantasia,
      cnpj_cpf: customer.cnpj_cpf,
      codigo_vendedor: null,
      local_user_id: (customer as any).user_id || undefined,
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
        const aiPrice = (aiProd as any).unit_price;
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


  // A product is "previously purchased" if it has a customer-specific price from Omie OR exists in local purchase history
  const isProductPreviouslyPurchased = useCallback((product: Product, account: ProductAccount): boolean => {
    const prices = account === 'oben' ? customerPricesOben : customerPricesColacor;
    if (prices[product.omie_codigo_produto]) return true;
    if (customerPurchaseHistory[product.codigo]) return true;
    if (customerPurchaseHistory[`pid:${product.id}`]) return true;
    if (customerPurchaseHistory[`omie:${product.omie_codigo_produto}`]) return true;
    return false;
  }, [customerPricesOben, customerPricesColacor, customerPurchaseHistory]);

  const getProductLastOrderDate = useCallback((product: Product): string | null => {
    // Check local history first
    const local = customerPurchaseHistory[product.codigo] || customerPurchaseHistory[`pid:${product.id}`];
    if (local) return local;
    // Check Omie history by omie_codigo_produto
    const omieDate = customerPurchaseHistory[`omie:${product.omie_codigo_produto}`];
    if (omieDate) {
      // Omie dates are DD/MM/YYYY, convert to ISO for consistency
      const parts = omieDate.split('/');
      if (parts.length === 3) {
        return `${parts[2]}-${parts[1]}-${parts[0]}T00:00:00`;
      }
      return omieDate;
    }
    return null;
  }, [customerPurchaseHistory]);

  const filteredObenProducts = useMemo(() => {
    const hasCustomerPrices = Object.keys(customerPricesOben).length > 0;
    const hasPurchaseHistory = Object.keys(customerPurchaseHistory).length > 0;
    const shouldPrioritize = hasCustomerPrices || hasPurchaseHistory;
    const sorted = [...obenProducts].sort((a, b) => {
      if (shouldPrioritize) {
        const aPrev = isProductPreviouslyPurchased(a, 'oben');
        const bPrev = isProductPreviouslyPurchased(b, 'oben');
        if (aPrev && !bPrev) return -1;
        if (!aPrev && bPrev) return 1;
      }
      if (a.ativo && !b.ativo) return -1;
      if (!a.ativo && b.ativo) return 1;
      return a.descricao.localeCompare(b.descricao);
    });
    if (!productSearch) return sorted.slice(0, 50);
    return sorted.filter(p =>
      p.descricao.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.codigo.toLowerCase().includes(productSearch.toLowerCase())
    ).slice(0, 50);
  }, [obenProducts, productSearch, customerPricesOben, customerPurchaseHistory, isProductPreviouslyPurchased]);

  const filteredColacorProducts = useMemo(() => {
    const hasCustomerPrices = Object.keys(customerPricesColacor).length > 0;
    const hasPurchaseHistory = Object.keys(customerPurchaseHistory).length > 0;
    const shouldPrioritize = hasCustomerPrices || hasPurchaseHistory;
    const sorted = [...colacorProducts].sort((a, b) => {
      if (shouldPrioritize) {
        const aPrev = isProductPreviouslyPurchased(a, 'colacor');
        const bPrev = isProductPreviouslyPurchased(b, 'colacor');
        if (aPrev && !bPrev) return -1;
        if (!aPrev && bPrev) return 1;
      }
      if (a.ativo && !b.ativo) return -1;
      if (!a.ativo && b.ativo) return 1;
      return a.descricao.localeCompare(b.descricao);
    });
    if (!productSearch) return sorted.slice(0, 50);
    return sorted.filter(p =>
      p.descricao.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.codigo.toLowerCase().includes(productSearch.toLowerCase())
    ).slice(0, 50);
  }, [colacorProducts, productSearch, customerPricesColacor, customerPurchaseHistory, isProductPreviouslyPurchased]);

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
      console.error(e);
      toast({ title: 'Erro', description: 'Não foi possível preparar o cadastro.', variant: 'destructive' });
    } finally {
      setCreatingLocalProfile(false);
    }
  };

  // Submit
  // Save as quote (orçamento) – no Omie sync
  const submitQuote = async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    setSubmitting(true);
    const hasObenProducts = obenProductItems.length > 0;
    const hasColacorProducts = colacorProductItems.length > 0;

    const selectedAddr = addresses.find(a => a.id === selectedAddress);
    const storedCustomerAddress = selectedAddr
      ? `${selectedAddr.street}, ${selectedAddr.number}${selectedAddr.complement ? ' - ' + selectedAddr.complement : ''} – ${selectedAddr.neighborhood}, ${selectedAddr.city}/${selectedAddr.state} – CEP: ${selectedAddr.zipCode}`
      : selectedCustomer.endereco
        ? `${selectedCustomer.endereco}, ${selectedCustomer.endereco_numero || 'S/N'}${selectedCustomer.complemento ? ' - ' + selectedCustomer.complemento : ''} – ${selectedCustomer.bairro || ''}, ${selectedCustomer.cidade || ''}/${selectedCustomer.estado || ''} – CEP: ${selectedCustomer.cep || ''}`
        : null;
    let storedCustomerPhone = selectedCustomer.telefone || null;
    const custUserId = customerUserId || user?.id;
    if (custUserId) {
      const { data: cp } = await supabase.from('profiles').select('phone').eq('user_id', custUserId).maybeSingle();
      if (cp?.phone) storedCustomerPhone = cp.phone;
    }

    try {
      const results: string[] = [];
      if (hasObenProducts) {
        const itemsPayload = obenProductItems.map(c => ({
          product_id: c.product.id, omie_codigo_produto: c.product.omie_codigo_produto,
          codigo: c.product.codigo, descricao: c.product.descricao, unidade: c.product.unidade,
          quantidade: c.quantity, valor_unitario: c.unit_price, valor_total: c.quantity * c.unit_price,
          ...(c.tint_cor_id ? { tint_cor_id: c.tint_cor_id, tint_nome_cor: c.tint_nome_cor, tint_formula_id: c.tint_formula_id } : {}),
        }));
        const { error: insertError } = await supabase
          .from('sales_orders').insert({
            customer_user_id: customerUserId || user.id, created_by: user.id,
            items: itemsPayload, subtotal: obenSubtotal, total: obenSubtotal,
            status: 'orcamento', notes: notes || null, account: 'oben',
            customer_address: storedCustomerAddress, customer_phone: storedCustomerPhone,
          } as any);
        if (insertError) throw insertError;
        results.push('Orçamento Oben salvo');
      }
      if (hasColacorProducts) {
        const itemsPayload = colacorProductItems.map(c => ({
          product_id: c.product.id, omie_codigo_produto: c.product.omie_codigo_produto,
          codigo: c.product.codigo, descricao: c.product.descricao, unidade: c.product.unidade,
          quantidade: c.quantity, valor_unitario: c.unit_price, valor_total: c.quantity * c.unit_price,
        }));
        const { error: insertError } = await supabase
          .from('sales_orders').insert({
            customer_user_id: customerUserId || user.id, created_by: user.id,
            items: itemsPayload, subtotal: colacorProdSubtotal, total: colacorProdSubtotal,
            status: 'orcamento', notes: notes || null, account: 'colacor',
            customer_address: storedCustomerAddress, customer_phone: storedCustomerPhone,
          } as any);
        if (insertError) throw insertError;
        results.push('Orçamento Colacor salvo');
      }
      toast({ title: 'Orçamento salvo', description: results.join(' | ') });
      setCart([]);
      setNotes('');
      navigate('/sales/quotes');
    } catch (error: any) {
      toast({ title: 'Erro ao salvar orçamento', description: error.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const submitOrder = async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    setSubmitting(true);
    const hasObenProducts = obenProductItems.length > 0;
    const hasColacorProducts = colacorProductItems.length > 0;
    const hasServices = serviceItems.length > 0;
    const results: string[] = [];

    // Pre-compute customer address/phone for storage
    const selectedAddr = addresses.find(a => a.id === selectedAddress);
    const storedCustomerAddress = selectedAddr
      ? `${selectedAddr.street}, ${selectedAddr.number}${selectedAddr.complement ? ' - ' + selectedAddr.complement : ''} – ${selectedAddr.neighborhood}, ${selectedAddr.city}/${selectedAddr.state} – CEP: ${selectedAddr.zipCode}`
      : selectedCustomer.endereco
        ? `${selectedCustomer.endereco}, ${selectedCustomer.endereco_numero || 'S/N'}${selectedCustomer.complemento ? ' - ' + selectedCustomer.complemento : ''} – ${selectedCustomer.bairro || ''}, ${selectedCustomer.cidade || ''}/${selectedCustomer.estado || ''} – CEP: ${selectedCustomer.cep || ''}`
        : null;
    let storedCustomerPhone = selectedCustomer.telefone || null;
    const custUserId2 = customerUserId || user?.id;
    if (custUserId2) {
      const { data: cp } = await supabase.from('profiles').select('phone').eq('user_id', custUserId2).maybeSingle();
      if (cp?.phone) storedCustomerPhone = cp.phone;
    }

    try {
      if (hasObenProducts) {
        const itemsPayload = obenProductItems.map(c => ({
          product_id: c.product.id, omie_codigo_produto: c.product.omie_codigo_produto,
          codigo: c.product.codigo, descricao: c.product.descricao, unidade: c.product.unidade,
          quantidade: c.quantity, valor_unitario: c.unit_price, valor_total: c.quantity * c.unit_price,
          ...(c.tint_cor_id ? { tint_cor_id: c.tint_cor_id, tint_nome_cor: c.tint_nome_cor, tint_formula_id: c.tint_formula_id } : {}),
        }));
        const { data: salesOrder, error: insertError } = await supabase
          .from('sales_orders').insert({
            customer_user_id: customerUserId || user.id, created_by: user.id,
            items: itemsPayload, subtotal: obenSubtotal, total: obenSubtotal,
            status: 'rascunho', notes: notes || null, account: 'oben',
            customer_address: storedCustomerAddress, customer_phone: storedCustomerPhone,
            ready_by_date: readyByDate || null,
          } as any).select('id').single();
        if (insertError) throw insertError;
        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido', account: 'oben', sales_order_id: salesOrder.id,
            codigo_cliente: selectedCustomer.codigo_cliente,
            codigo_vendedor: selectedCustomer.codigo_vendedor,
             items: obenProductItems.map(c => ({
               omie_codigo_produto: c.product.omie_codigo_produto, quantidade: c.quantity, valor_unitario: c.unit_price,
               descricao: c.product.descricao,
               ...(c.tint_cor_id ? { tint_cor_id: c.tint_cor_id, tint_nome_cor: c.tint_nome_cor } : {}),
             })),
            observacao: notes, codigo_parcela: selectedParcelaOben, quantidade_volumes: volumesOben || undefined,
            ordem_compra: ordemCompra || undefined,
          },
        });
        if (!omieError) results.push(`PV Oben ${omieResult?.omie_numero_pedido || ''}`);
        else results.push('PV Oben (pendente ERP)');
      }

      if (hasColacorProducts) {
        const itemsPayload = colacorProductItems.map(c => ({
          product_id: c.product.id, omie_codigo_produto: c.product.omie_codigo_produto,
          codigo: c.product.codigo, descricao: c.product.descricao, unidade: c.product.unidade,
          quantidade: c.quantity, valor_unitario: c.unit_price, valor_total: c.quantity * c.unit_price,
        }));
        const { data: salesOrder, error: insertError } = await supabase
          .from('sales_orders').insert({
            customer_user_id: customerUserId || user.id, created_by: user.id,
            items: itemsPayload, subtotal: colacorProdSubtotal, total: colacorProdSubtotal,
            status: 'rascunho', notes: notes || null, account: 'colacor',
            customer_address: storedCustomerAddress, customer_phone: storedCustomerPhone,
            ready_by_date: readyByDate || null,
          } as any).select('id').single();
        if (insertError) throw insertError;
        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido', account: 'colacor', sales_order_id: salesOrder.id,
            codigo_cliente: selectedCustomer.codigo_cliente_colacor || selectedCustomer.codigo_cliente,
            codigo_vendedor: selectedCustomer.codigo_vendedor_colacor ?? selectedCustomer.codigo_vendedor,
            items: colacorProductItems.map(c => ({
              omie_codigo_produto: c.product.omie_codigo_produto, quantidade: c.quantity, valor_unitario: c.unit_price,
            })),
            observacao: notes, codigo_parcela: selectedParcelaColacor, quantidade_volumes: volumesColacor || undefined,
            ordem_compra: ordemCompra || undefined,
          },
        });
        if (!omieError) {
          results.push(`PV Colacor ${omieResult?.omie_numero_pedido || ''}`);
          // Auto-create production orders for "produto acabado" items (tipo_produto = "04" or 4)
          const produtoAcabadoItems = colacorProductItems.filter(c => {
            const tp = c.product.metadata?.tipo_produto;
            return tp === '04' || tp === 4 || tp === '4';
          });
          if (produtoAcabadoItems.length > 0) {
            if (!defaultProductionAssigneeId) {
              toast({
                title: 'Ordem de Produção não criada',
                description: 'Responsável padrão de produção não configurado. Configure em Governance > Settings.',
                variant: 'destructive',
              });
              console.warn('[UnifiedOrder] Skipping production order auto-creation: default_production_assignee_id is not set');
            } else {
            try {
              await supabase.functions.invoke('omie-vendas-sync', {
                body: {
                  action: 'criar_ordem_producao', account: 'colacor',
                  sales_order_id: salesOrder.id,
                  items: produtoAcabadoItems.map(c => ({
                    product_id: c.product.id,
                    omie_codigo_produto: c.product.omie_codigo_produto,
                    codigo: c.product.codigo,
                    descricao: c.product.descricao,
                    quantidade: c.quantity,
                    unidade: c.product.unidade,
                    assigned_to: defaultProductionAssigneeId,
                  })),
                },
              });
              console.log('[UnifiedOrder] Production orders created for', produtoAcabadoItems.length, 'items');
            } catch (opErr) {
              console.warn('[UnifiedOrder] Failed to create production orders:', opErr);
            }
            }
          }
        } else {
          results.push('PV Colacor (pendente ERP)');
        }
      }

      if (hasServices) {
        const orderId = crypto.randomUUID();
        const buildToolInfo = (c: ServiceCartItem): string => {
          const parts: string[] = [];
          parts.push(getToolName(c.userTool));
          const specs = c.userTool.specifications;
          if (specs && typeof specs === 'object') {
            const specEntries = Object.entries(specs).filter(([, v]) => v);
            if (specEntries.length > 0) parts.push(specEntries.map(([k, v]) => `${k}: ${v}`).join(', '));
          }
          if (c.notes) parts.push(c.notes);
          return parts.join(' | ');
        };
        const orderItems = serviceItems.map(c => {
          const price = getServicePrice(c);
          return {
            category: c.servico?.descricao || '', quantity: c.quantity,
            omie_codigo_servico: c.servico?.omie_codigo_servico, userToolId: c.userTool.id,
            toolName: getToolName(c.userTool), notes: c.notes, photos: c.photos || [],
            unitPrice: price || 0, toolCategoryId: c.userTool.tool_category_id,
            toolSpecs: c.userTool.specifications || {},
          };
        });
        const selectedAddressData = addresses.find(a => a.id === selectedAddress);
        const addressPayload = selectedAddressData ? {
          street: selectedAddressData.street, number: selectedAddressData.number,
          complement: selectedAddressData.complement || undefined,
          neighborhood: selectedAddressData.neighborhood, city: selectedAddressData.city,
          state: selectedAddressData.state, zip_code: selectedAddressData.zipCode,
        } : undefined;
        const orderData = {
          items: orderItems, service_type: 'padrao', subtotal: serviceSubtotal,
          delivery_fee: DELIVERY_FEES[deliveryOption],
          total: serviceSubtotal + DELIVERY_FEES[deliveryOption],
          notes: serviceItems.map(buildToolInfo).filter(Boolean).join(' || '),
          payment_method: afiacaoPaymentMethod,
        };
        const profileData = {
          name: selectedCustomer.nome_fantasia || selectedCustomer.razao_social,
          document: selectedCustomer.cnpj_cpf || undefined,
        };
        const staffContext = {
          customerOmieCode: selectedCustomer.codigo_cliente_afiacao || selectedCustomer.codigo_cliente,
          customerUserId: customerUserId || null,
          customerCodigoVendedor: selectedCustomer.codigo_vendedor_afiacao ?? selectedCustomer.codigo_vendedor ?? null,
        };
        const result = await syncOrderToOmie(orderId, orderData, profileData, addressPayload, staffContext);
        if (result.success) results.push(`OS ${result.omie_os?.cNumOS || ''}`);
        else results.push('OS Afiação (pendente ERP)');
      }

      // Prepare success dialog data
      const allItems: Array<{ description: string; quantity: number; unitPrice: number; codigo?: string; unidade?: string; tintCorId?: string; tintNomeCor?: string }> = [
        ...obenProductItems.map(c => ({ description: c.product.descricao, quantity: c.quantity, unitPrice: c.unit_price, codigo: c.product.codigo, unidade: c.product.unidade, tintCorId: c.tint_cor_id, tintNomeCor: c.tint_nome_cor })),
        ...colacorProductItems.map(c => ({ description: c.product.descricao, quantity: c.quantity, unitPrice: c.unit_price, codigo: c.product.codigo, unidade: c.product.unidade })),
        ...serviceItems.map(c => ({ 
          description: c.servico?.descricao || getToolName(c.userTool), 
          quantity: c.quantity, 
          unitPrice: getServicePrice(c) || 0 
        })),
      ];

      // Build print data for each company
      const dateShort = new Date().toLocaleDateString('pt-BR');
      const printDataList: import('@/components/OrderPrintLayout').PrintOrderData[] = [];

      const findParcelaDesc = (codigo: string, formas: FormaPagamento[]) => {
        const found = formas.find(f => f.codigo === codigo);
        return found?.descricao || codigo;
      };

      const selectedAddr = addresses.find(a => a.id === selectedAddress);
      const fullCustomerAddress = selectedAddr
        ? `${selectedAddr.street}, ${selectedAddr.number}${selectedAddr.complement ? ' - ' + selectedAddr.complement : ''} – ${selectedAddr.neighborhood}, ${selectedAddr.city}/${selectedAddr.state} – CEP: ${selectedAddr.zipCode}`
        : selectedCustomer.endereco
          ? `${selectedCustomer.endereco}, ${selectedCustomer.endereco_numero || 'S/N'}${selectedCustomer.complemento ? ' - ' + selectedCustomer.complemento : ''} – ${selectedCustomer.bairro || ''}, ${selectedCustomer.cidade || ''}/${selectedCustomer.estado || ''} – CEP: ${selectedCustomer.cep || ''}`
          : undefined;

      // Fetch customer phone from profile, fallback to Omie data
      let customerPhone = selectedCustomer.telefone || '';
      const custUserId = customerUserId || user?.id;
      if (custUserId) {
        const { data: custProfile } = await supabase.from('profiles').select('phone').eq('user_id', custUserId).maybeSingle();
        if (custProfile?.phone) customerPhone = custProfile.phone;
      }

      if (obenProductItems.length > 0) {
        const obenOrderNum = results.find(r => r.startsWith('PV Oben'))?.replace('PV Oben ', '') || '';
        const obenProfile = companyProfiles.oben;
        printDataList.push({
          companyName: obenProfile?.legal_name || 'OBEN COMÉRCIO LTDA',
          companyCnpj: obenProfile?.cnpj || '51.027.034/0001-00',
          companyPhone: obenProfile?.phone || '(37) 9987-8190',
          companyAddress: obenProfile?.address || 'Av. Primeiro de Junho, 70 – Centro, Divinópolis/MG – CEP: 35.500-002',
          orderNumber: obenOrderNum,
          date: dateShort,
          customerName: selectedCustomer.razao_social,
          customerDocument: selectedCustomer.cnpj_cpf || '',
          customerAddress: fullCustomerAddress,
          customerPhone,
          condPagamento: findParcelaDesc(selectedParcelaOben, formasPagamentoOben),
          parcelaCode: selectedParcelaOben,
          items: obenProductItems.map(c => ({
            codigo: c.product.codigo,
            descricao: c.product.descricao,
            quantidade: c.quantity,
            unidade: c.product.unidade,
            valorUnitario: c.unit_price,
            valorTotal: c.quantity * c.unit_price,
            tintCorId: c.tint_cor_id,
            tintNomeCor: c.tint_nome_cor,
          })),
          subtotal: obenSubtotal,
          desconto: 0,
          frete: 0,
          total: obenSubtotal,
          observacoes: notes || undefined,
          isOben: true,
        });
      }

      if (colacorProductItems.length > 0) {
        const colacorOrderNum = results.find(r => r.startsWith('PV Colacor'))?.replace('PV Colacor ', '') || '';
        const colacorProfile = companyProfiles.colacor;
        printDataList.push({
          companyName: colacorProfile?.legal_name || 'COLACOR COMERCIAL LTDA',
          companyCnpj: colacorProfile?.cnpj || '15.422.799/0001-81',
          companyPhone: colacorProfile?.phone || '(37) 3222-1035',
          companyAddress: colacorProfile?.address || 'Av. Primeiro de Junho, 48 – Centro, Divinópolis/MG – CEP: 35.500-002',
          orderNumber: colacorOrderNum,
          date: dateShort,
          customerName: selectedCustomer.razao_social,
          customerDocument: selectedCustomer.cnpj_cpf || '',
          customerAddress: fullCustomerAddress,
          customerPhone,
          condPagamento: findParcelaDesc(selectedParcelaColacor, formasPagamentoColacor),
          parcelaCode: selectedParcelaColacor,
          items: colacorProductItems.map(c => ({
            codigo: c.product.codigo,
            descricao: c.product.descricao,
            quantidade: c.quantity,
            unidade: c.product.unidade,
            valorUnitario: c.unit_price,
            valorTotal: c.quantity * c.unit_price,
          })),
          subtotal: colacorProdSubtotal,
          desconto: 0,
          frete: 0,
          total: colacorProdSubtotal,
          isOben: false,
        });
      }

      if (serviceItems.length > 0) {
        const afiacaoOrderNum = results.find(r => r.startsWith('OS'))?.replace('OS ', '') || '';
        const afiacaoProfile = companyProfiles.afiacao;
        printDataList.push({
          companyName: afiacaoProfile?.legal_name || 'COLACOR S.C LTDA',
          companyCnpj: afiacaoProfile?.cnpj || '55.555.305/0001-51',
          companyPhone: afiacaoProfile?.phone || '(37) 9987-8190',
          companyAddress: afiacaoProfile?.address || 'Av. Primeiro de Junho, 50 – Centro, Divinópolis/MG – CEP: 35.500-002',
          orderNumber: afiacaoOrderNum,
          date: dateShort,
          customerName: selectedCustomer.razao_social,
          customerDocument: selectedCustomer.cnpj_cpf || '',
          customerAddress: fullCustomerAddress,
          customerPhone,
          condPagamento: afiacaoPaymentMethod === 'a_vista' ? 'À Vista' : afiacaoPaymentMethod,
          items: serviceItems.map(c => {
            const price = getServicePrice(c) || 0;
            return {
              codigo: c.servico?.omie_codigo_servico?.toString() || '-',
              descricao: c.servico?.descricao || getToolName(c.userTool),
              quantidade: c.quantity,
              unidade: 'SV',
              valorUnitario: price,
              valorTotal: price * c.quantity,
            };
          }),
          subtotal: serviceSubtotal,
          desconto: 0,
          frete: DELIVERY_FEES[deliveryOption],
          total: serviceSubtotal + DELIVERY_FEES[deliveryOption],
          isOben: false,
        });
      }

      setLastOrderData({
        customerName: selectedCustomer.nome_fantasia || selectedCustomer.razao_social,
        customerDocument: selectedCustomer.cnpj_cpf || '',
        items: allItems,
        total: totalEstimated,
        orderNumbers: results,
        printDataList,
      });
      
      setOrderSuccessOpen(true);
      setCart([]);
      setNotes('');
    } catch (error: any) {
      toast({ title: 'Erro ao criar pedido', description: error.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const clearCustomer = () => {
    setSelectedCustomer(null);
    setCustomerPricesOben({});
    setCustomerPricesColacor({});
    setCart([]);
    setCustomerUserId(null);
    setUserTools([]);
    setSelectedParcelaOben('999');
    setSelectedParcelaColacor('999');
    setVendedorDivergencias([]);
    setOrdemCompra('');
    setAddresses([]);
    setSelectedAddress('');
    setCustomerPurchaseHistory({});
  };

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
