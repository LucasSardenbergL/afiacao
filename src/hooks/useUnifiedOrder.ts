import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { syncOrderToOmie, OmieServico } from '@/services/omieService';
import { usePricingEngine } from '@/hooks/usePricingEngine';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';
import { DELIVERY_FEES, DeliveryOption } from '@/types';
import type { AIOrderResult, AICustomerMatch } from '@/components/UnifiedAIAssistant';
import type { IdentifiedItem } from '@/components/VoiceServiceInput';

/* ─── Types ─── */
export type ProductAccount = 'oben' | 'colacor';

export interface Product {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  omie_codigo_produto: number;
  account?: string;
  is_tintometric?: boolean;
  tint_type?: string;
}

export interface ProductCartItem {
  type: 'product';
  product: Product;
  quantity: number;
  unit_price: number;
  account: ProductAccount;
  // Tintometric optional fields
  tint_cor_id?: string;
  tint_nome_cor?: string;
  tint_custo_corantes?: number;
  tint_formula_id?: string;
}

export interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  specifications: Record<string, unknown> | null;
  tool_categories?: { name: string };
}

export interface ServiceCartItem {
  type: 'service';
  userTool: UserTool;
  servico: OmieServico | null;
  quantity: number;
  notes?: string;
  photos: string[];
}

export type CartItem = ProductCartItem | ServiceCartItem;

export interface OmieCustomer {
  codigo_cliente: number;
  razao_social: string;
  nome_fantasia: string;
  cnpj_cpf: string;
  codigo_vendedor: number | null;
  local_user_id?: string | null;
  codigo_cliente_colacor?: number | null;
  codigo_vendedor_colacor?: number | null;
  codigo_cliente_afiacao?: number | null;
  codigo_vendedor_afiacao?: number | null;
}

export interface FormaPagamento {
  codigo: string;
  descricao: string;
}

export interface AddressData {
  id: string;
  label: string;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  suggested_interval_days: number | null;
}

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

  // Delivery
  const [deliveryOption, setDeliveryOption] = useState<DeliveryOption>('coleta_entrega');
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string>('');
  const [showAddressOptions, setShowAddressOptions] = useState(false);

  // Cart
  const [cart, setCart] = useState<CartItem[]>([]);
  // Tintometric pending product (opens color dialog)
  const [tintPendingProduct, setTintPendingProduct] = useState<Product | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('oben');
  
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

  const productItems = useMemo(() => cart.filter((c): c is ProductCartItem => c.type === 'product'), [cart]);
  const obenProductItems = useMemo(() => productItems.filter(c => c.account === 'oben'), [productItems]);
  const colacorProductItems = useMemo(() => productItems.filter(c => c.account === 'colacor'), [productItems]);
  const serviceItems = useMemo(() => cart.filter((c): c is ServiceCartItem => c.type === 'service'), [cart]);
  const cartProductIds = useMemo(() => productItems.map(c => c.product.id), [productItems]);

  // Auto-calculate volumes: packaging units (5L, GL, LT, BD, BH) count their qty; all others = 1 volume total
  const VOLUME_UNITS = ['5L', 'GL', 'LT', 'BD', 'BH'];
  const calcVolumes = (items: ProductCartItem[]) => {
    let volumeQty = 0;
    let hasNonVolume = false;
    for (const item of items) {
      const un = (item.product.unidade || '').toUpperCase().trim();
      if (VOLUME_UNITS.includes(un)) {
        volumeQty += item.quantity;
      } else {
        hasNonVolume = true;
      }
    }
    return volumeQty + (hasNonVolume ? 1 : 0);
  };
  const volumesOben = useMemo(() => calcVolumes(obenProductItems), [obenProductItems]);
  const volumesColacor = useMemo(() => calcVolumes(colacorProductItems), [colacorProductItems]);

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
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type')
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
            .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type')
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
          .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type')
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
            .select('user_id')
            .or(`document.eq.${docClean},document.eq.${cust.cnpj_cpf}`)
            .limit(1)
            .maybeSingle();
          if (profile?.user_id) localUserId = profile.user_id;
        }
      }
      if (localUserId) {
        setCustomerUserId(localUserId);
        loadUserTools(localUserId);
        loadAddresses(localUserId);
        loadPriceHistory();
      }

      const [
        priceOben, priceColacor, parcelaOben, parcelaColacor,
        localPriceResult, colacorClientResult, afiacaoClientResult,
      ] = await Promise.all([
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

      if (colacorClientResult?.data?.cliente) {
        cust.codigo_cliente_colacor = colacorClientResult.data.cliente.codigo_cliente;
        cust.codigo_vendedor_colacor = colacorClientResult.data.cliente.codigo_vendedor || null;
      }
      if (afiacaoClientResult?.data?.codigo_cliente) {
        cust.codigo_cliente_afiacao = afiacaoClientResult.data.codigo_cliente;
        cust.codigo_vendedor_afiacao = afiacaoClientResult.data.codigo_vendedor || null;
      }
      setSelectedCustomer({ ...cust });

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

  // Product Cart Actions
  const getProductPrice = useCallback((product: Product): number => {
    const account = (product.account || 'oben') as ProductAccount;
    const prices = account === 'oben' ? customerPricesOben : customerPricesColacor;
    const omiePrice = prices[product.omie_codigo_produto];
    return (omiePrice && omiePrice > 0) ? omiePrice : product.valor_unitario;
  }, [customerPricesOben, customerPricesColacor]);

  const addProductToCart = (product: Product) => {
    // If tintometric base, open color dialog instead of adding directly
    if (product.is_tintometric && product.tint_type === 'base') {
      setTintPendingProduct(product);
      return;
    }
    const account = (product.account || 'oben') as ProductAccount;
    const existing = cart.find((c): c is ProductCartItem => c.type === 'product' && c.product.id === product.id && !c.tint_formula_id);
    if (existing) {
      setCart(cart.map(c => c.type === 'product' && (c as ProductCartItem).product.id === product.id && !(c as ProductCartItem).tint_formula_id
        ? { ...c, quantity: c.quantity + 1 } as ProductCartItem : c));
    } else {
      setCart([...cart, { type: 'product', product, quantity: 1, unit_price: getProductPrice(product), account }]);
    }
  };

  const addTintProductToCart = (product: Product, formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number) => {
    const account = (product.account || 'oben') as ProductAccount;
    // Each tint formula selection is a unique cart item
    const existing = cart.find((c): c is ProductCartItem => c.type === 'product' && c.tint_formula_id === formulaId);
    if (existing) {
      setCart(cart.map(c => c.type === 'product' && (c as ProductCartItem).tint_formula_id === formulaId
        ? { ...c, quantity: c.quantity + 1 } as ProductCartItem : c));
    } else {
      setCart([...cart, {
        type: 'product', product, quantity: 1, unit_price: precoFinal, account,
        tint_cor_id: corId, tint_nome_cor: nomeCor, tint_custo_corantes: custoCorantes, tint_formula_id: formulaId,
      }]);
    }
    setTintPendingProduct(null);
  };

  // Service Cart Actions
  const addServiceToCart = (tool: UserTool) => {
    if (cart.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === tool.id)) {
      toast({ title: 'Já adicionada', description: 'Esta ferramenta já está no carrinho.' });
      return;
    }
    setCart([...cart, { type: 'service', userTool: tool, servico: null, quantity: 1, photos: [] }]);
  };

  const updateServiceServico = (toolId: string, codigoServico: number) => {
    const servico = servicos.find(s => s.omie_codigo_servico === codigoServico) || null;
    setCart(cart.map(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === toolId
      ? { ...c, servico } as ServiceCartItem : c));
  };

  const updateServiceNotes = (toolId: string, newNotes: string) => {
    setCart(cart.map(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === toolId
      ? { ...c, notes: newNotes } as ServiceCartItem : c));
  };

  const updateServicePhotos = (toolId: string, photos: string[]) => {
    setCart(cart.map(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === toolId
      ? { ...c, photos } as ServiceCartItem : c));
  };

  const getServicePrice = useCallback((item: ServiceCartItem): number | null => {
    const serviceType = item.servico?.descricao || '';
    const lastPrice = getLastPrice(item.userTool.id, serviceType);
    if (lastPrice !== null) return lastPrice;
    const specs = item.userTool.specifications as Record<string, string> | null;
    return calculatePrice({ tool_category_id: item.userTool.tool_category_id, specifications: specs });
  }, [getLastPrice, calculatePrice]);

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

  // Generic Cart
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

  const obenSubtotal = useMemo(() => obenProductItems.reduce((s, c) => s + c.quantity * c.unit_price, 0), [obenProductItems]);
  const colacorProdSubtotal = useMemo(() => colacorProductItems.reduce((s, c) => s + c.quantity * c.unit_price, 0), [colacorProductItems]);
  const serviceSubtotal = useMemo(() => {
    return serviceItems.reduce((s, c) => {
      const price = getServicePrice(c);
      return s + (price !== null ? price * c.quantity : 0);
    }, 0);
  }, [serviceItems, getServicePrice]);
  const totalEstimated = obenSubtotal + colacorProdSubtotal + serviceSubtotal;

  const filteredObenProducts = useMemo(() => {
    const sorted = [...obenProducts].sort((a, b) => {
      if (a.ativo && !b.ativo) return -1;
      if (!a.ativo && b.ativo) return 1;
      return a.descricao.localeCompare(b.descricao);
    });
    if (!productSearch) return sorted.slice(0, 50);
    return sorted.filter(p =>
      p.descricao.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.codigo.toLowerCase().includes(productSearch.toLowerCase())
    ).slice(0, 50);
  }, [obenProducts, productSearch]);

  const filteredColacorProducts = useMemo(() => {
    const sorted = [...colacorProducts].sort((a, b) => {
      if (a.ativo && !b.ativo) return -1;
      if (!a.ativo && b.ativo) return 1;
      return a.descricao.localeCompare(b.descricao);
    });
    if (!productSearch) return sorted.slice(0, 50);
    return sorted.filter(p =>
      p.descricao.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.codigo.toLowerCase().includes(productSearch.toLowerCase())
    ).slice(0, 50);
  }, [colacorProducts, productSearch]);

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
  const submitOrder = async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    setSubmitting(true);
    const hasObenProducts = obenProductItems.length > 0;
    const hasColacorProducts = colacorProductItems.length > 0;
    const hasServices = serviceItems.length > 0;
    const results: string[] = [];

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
        if (!omieError) results.push(`PV Colacor ${omieResult?.omie_numero_pedido || ''}`);
        else results.push('PV Colacor (pendente ERP)');
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
        : undefined;

      // Fetch customer phone from profile
      let customerPhone = '';
      const custUserId = customerUserId || user?.id;
      if (custUserId) {
        const { data: custProfile } = await supabase.from('profiles').select('phone').eq('user_id', custUserId).maybeSingle();
        if (custProfile?.phone) customerPhone = custProfile.phone;
      }

      if (obenProductItems.length > 0) {
        const obenOrderNum = results.find(r => r.startsWith('PV Oben'))?.replace('PV Oben ', '') || '';
        printDataList.push({
          companyName: 'OBEN COMÉRCIO LTDA',
          companyCnpj: '51.027.034/0001-00',
          companyPhone: '(37) 9987-8190',
          companyAddress: 'Av. Primeiro de Junho, 70 – Centro, Divinópolis/MG – CEP: 35.500-002',
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
        printDataList.push({
          companyName: 'COLACOR COMERCIAL LTDA',
          companyCnpj: '15.422.799/0001-81',
          companyPhone: '(37) 3222-1035',
          companyAddress: 'Av. Primeiro de Junho, 48 – Centro, Divinópolis/MG – CEP: 35.500-002',
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
        printDataList.push({
          companyName: 'COLACOR S.C LTDA',
          companyCnpj: '55.555.305/0001-51',
          companyPhone: '(37) 9987-8190',
          companyAddress: 'Av. Primeiro de Junho, 50 – Centro, Divinópolis/MG – CEP: 35.500-002',
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
    isOrdemCompraCustomer: selectedCustomer?.cnpj_cpf?.replace(/\D/g, '') === '64422892000100',
    // Delivery
    deliveryOption, setDeliveryOption, addresses, selectedAddress, setSelectedAddress,
    selectedTimeSlot, setSelectedTimeSlot, showAddressOptions, setShowAddressOptions,
    // Cart
    cart, notes, setNotes, submitting, activeTab, setActiveTab,
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
    submitOrder, loadUserTools,
    // Order success
    orderSuccessOpen, setOrderSuccessOpen, lastOrderData,
    // Navigate
    navigate,
  };
}
