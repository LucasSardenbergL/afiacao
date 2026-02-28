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
import { PhotoUpload } from '@/components/PhotoUpload';
import { VoiceServiceInput, IdentifiedItem } from '@/components/VoiceServiceInput';
import { ToolImageIdentifier } from '@/components/ToolImageIdentifier';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { syncOrderToOmie, OmieServico } from '@/services/omieService';
import { usePricingEngine } from '@/hooks/usePricingEngine';
import { usePriceHistory } from '@/hooks/usePriceHistory';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';
import {
  DELIVERY_OPTIONS,
  TIME_SLOTS,
  DELIVERY_FEES,
  DeliveryOption,
} from '@/types';
import {
  Loader2, Search, Plus, Minus, Trash2, User, ShoppingCart, Send,
  ChevronLeft, Package, CheckCircle, Wrench, AlertCircle, Scissors, AlertTriangle, Building2,
  MapPin, Clock, Check,
} from 'lucide-react';

/* ─── Types ─── */
type ProductAccount = 'oben' | 'colacor';

interface Product {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  omie_codigo_produto: number;
  account?: string;
}

interface ProductCartItem {
  type: 'product';
  product: Product;
  quantity: number;
  unit_price: number;
  account: ProductAccount;
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
  photos: string[];
}

type CartItem = ProductCartItem | ServiceCartItem;

interface OmieCustomer {
  codigo_cliente: number;
  razao_social: string;
  nome_fantasia: string;
  cnpj_cpf: string;
  codigo_vendedor: number | null;
  local_user_id?: string | null;
  // Per-account resolved codes
  codigo_cliente_colacor?: number | null;
  codigo_vendedor_colacor?: number | null;
  codigo_cliente_afiacao?: number | null;
  codigo_vendedor_afiacao?: number | null;
}

interface FormaPagamento {
  codigo: string;
  descricao: string;
}

interface AddressData {
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

interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  suggested_interval_days: number | null;
}

const PAYMENT_OPTIONS = [
  { id: 'a_vista', label: 'À vista', description: 'PIX ou pagamento presencial na entrega/retirada' },
  { id: '30dd', label: '30 dias', description: 'Vencimento em 30 dias' },
  { id: '30_60dd', label: '30/60 dias', description: '2 parcelas: 30 e 60 dias' },
  { id: '30_60_90dd', label: '30/60/90 dias', description: '3 parcelas: 30, 60 e 90 dias' },
  { id: '28dd', label: '28 dias', description: 'Vencimento em 28 dias' },
  { id: '28_56dd', label: '28/56 dias', description: '2 parcelas: 28 e 56 dias' },
  { id: '28_56_84dd', label: '28/56/84 dias', description: '3 parcelas: 28, 56 e 84 dias' },
] as const;

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

  // Products by account
  const [obenProducts, setObenProducts] = useState<Product[]>([]);
  const [colacorProducts, setColacorProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [loadingObenProducts, setLoadingObenProducts] = useState(true);
  const [loadingColacorProducts, setLoadingColacorProducts] = useState(true);
  const [customerPricesOben, setCustomerPricesOben] = useState<Record<number, number>>({});
  const [customerPricesColacor, setCustomerPricesColacor] = useState<Record<number, number>>({});

  // Afiação (Colacor services)
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
  const [customerParcelaRankingOben, setCustomerParcelaRankingOben] = useState<string[]>([]);
  const [customerParcelaRankingColacor, setCustomerParcelaRankingColacor] = useState<string[]>([]);
  const [afiacaoPaymentMethod, setAfiacaoPaymentMethod] = useState<string>('a_vista');

  // Delivery (for afiação)
  const [deliveryOption, setDeliveryOption] = useState<DeliveryOption>('coleta_entrega');
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string>('');
  const [showAddressOptions, setShowAddressOptions] = useState(false);

  // Cart
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('oben');

  // Pricing
  const { loadDefaultPrices, calculatePrice } = usePricingEngine();
  const { loadPriceHistory, getLastPrice } = usePriceHistory(customerUserId || undefined);

  const productItems = useMemo(() => cart.filter((c): c is ProductCartItem => c.type === 'product'), [cart]);
  const obenProductItems = useMemo(() => productItems.filter(c => c.account === 'oben'), [productItems]);
  const colacorProductItems = useMemo(() => productItems.filter(c => c.account === 'colacor'), [productItems]);
  const serviceItems = useMemo(() => cart.filter((c): c is ServiceCartItem => c.type === 'service'), [cart]);
  const cartProductIds = useMemo(() => productItems.map(c => c.product.id), [productItems]);

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

  const currentStep = !selectedCustomer ? 0 : cart.length === 0 ? 1 : 2;

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff]);

  useEffect(() => {
    if (isStaff) {
      loadProductsForAccount('oben');
      loadProductsForAccount('colacor');
      loadFormasPagamento('oben');
      loadFormasPagamento('colacor');
      loadServicosColacor();
      loadDefaultPrices();
      loadCategories();
    }
  }, [isStaff]);

  // Customer search (Oben Omie account - has all clients)
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
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account')
        .eq('account', account)
        .not('familia', 'ilike', '%imobilizado%')
        .not('familia', 'ilike', '%uso e consumo%')
        .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
        .not('familia', 'ilike', '%jumbos de lixa para discos%')
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
            .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account')
            .eq('account', account)
            .not('familia', 'ilike', '%imobilizado%')
            .not('familia', 'ilike', '%uso e consumo%')
            .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
            .not('familia', 'ilike', '%jumbos de lixa para discos%')
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

  const syncStockInBackground = async (account: ProductAccount, setProds: React.Dispatch<React.SetStateAction<Product[]>>) => {
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
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account')
        .eq('account', account)
        .not('familia', 'ilike', '%imobilizado%')
        .not('familia', 'ilike', '%uso e consumo%')
        .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
        .not('familia', 'ilike', '%jumbos de lixa para discos%')
        .not('familia', 'ilike', '%material para tingimix%')
        .order('descricao');
      if (refreshed) setProds(refreshed as Product[]);
    } catch (e) { console.error(`Background stock sync error (${account}):`, e); }
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
          id: addr.id,
          label: addr.label,
          street: addr.street,
          number: addr.number,
          complement: addr.complement,
          neighborhood: addr.neighborhood,
          city: addr.city,
          state: addr.state,
          zipCode: addr.zip_code,
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

      // Resolve local user_id - try omie_clientes first, then fallback to profile by document
      let localUserId = cust.local_user_id || null;
      if (!localUserId) {
        const { data: mapping } = await supabase
          .from('omie_clientes')
          .select('user_id')
          .eq('omie_codigo_cliente', cust.codigo_cliente)
          .maybeSingle();
        if (mapping?.user_id) localUserId = mapping.user_id;
      }
      // Fallback: search by CNPJ/CPF in profiles (handles different omie_codigo_cliente across accounts)
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

      // Resolve per-account codigo_cliente in parallel with price loading
      const [
        priceOben, priceColacor,
        parcelaOben, parcelaColacor,
        localPriceResult,
        colacorClientResult,
        afiacaoClientResult,
      ] = await Promise.all([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_precos_cliente', codigo_cliente: cust.codigo_cliente, account: 'oben' },
        }),
        // For colacor prices, we'll use colacor's codigo_cliente once resolved; for now fetch with oben's (may fail gracefully)
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
          ? supabase
              .from('sales_price_history')
              .select('product_id, unit_price, created_at')
              .eq('customer_user_id', localUserId)
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: null }),
        // Resolve Colacor codigo_cliente by document
        cust.cnpj_cpf
          ? supabase.functions.invoke('omie-vendas-sync', {
              body: { action: 'buscar_cliente', document: cust.cnpj_cpf, account: 'colacor' },
            })
          : Promise.resolve({ data: null }),
        // Resolve Afiação codigo_cliente by document
        cust.cnpj_cpf
          ? supabase.functions.invoke('omie-sync', {
              body: { action: 'buscar_cliente_por_documento', document: cust.cnpj_cpf },
            })
          : Promise.resolve({ data: null }),
      ]);

      // Store per-account resolved codes
      if (colacorClientResult?.data?.cliente) {
        cust.codigo_cliente_colacor = colacorClientResult.data.cliente.codigo_cliente;
        cust.codigo_vendedor_colacor = colacorClientResult.data.cliente.codigo_vendedor || null;
      }
      if (afiacaoClientResult?.data?.codigo_cliente) {
        cust.codigo_cliente_afiacao = afiacaoClientResult.data.codigo_cliente;
        cust.codigo_vendedor_afiacao = afiacaoClientResult.data.codigo_vendedor || null;
      }
      // Update the selectedCustomer with resolved codes
      setSelectedCustomer({ ...cust });

      // Build local prices map
      const localPricesByProduct: Record<string, number> = {};
      if (localPriceResult.data && localPriceResult.data.length > 0) {
        for (const row of localPriceResult.data) {
          if (!localPricesByProduct[row.product_id]) {
            localPricesByProduct[row.product_id] = row.unit_price;
          }
        }
      }

      // Map product UUIDs → omie codes
      let localPricesByOmie: Record<number, number> = {};
      const productIds = Object.keys(localPricesByProduct);
      if (productIds.length > 0) {
        const { data: productMappings } = await supabase
          .from('omie_products')
          .select('id, omie_codigo_produto')
          .in('id', productIds);
        if (productMappings) {
          for (const pm of productMappings) {
            const price = localPricesByProduct[pm.id];
            if (price && price > 0) localPricesByOmie[pm.omie_codigo_produto] = price;
          }
        }
      }

      // Merge prices: local as base, Omie overrides
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

    // Validate vendedor
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

  // ─── Product Cart Actions ───
  const getProductPrice = useCallback((product: Product): number => {
    const account = (product.account || 'oben') as ProductAccount;
    const prices = account === 'oben' ? customerPricesOben : customerPricesColacor;
    const omiePrice = prices[product.omie_codigo_produto];
    return (omiePrice && omiePrice > 0) ? omiePrice : product.valor_unitario;
  }, [customerPricesOben, customerPricesColacor]);

  const addProductToCart = (product: Product) => {
    const account = (product.account || 'oben') as ProductAccount;
    const existing = cart.find((c): c is ProductCartItem => c.type === 'product' && c.product.id === product.id);
    if (existing) {
      setCart(cart.map(c => c.type === 'product' && (c as ProductCartItem).product.id === product.id
        ? { ...c, quantity: c.quantity + 1 } as ProductCartItem : c));
    } else {
      setCart([...cart, { type: 'product', product, quantity: 1, unit_price: getProductPrice(product), account }]);
    }
  };

  // ─── Service Cart Actions ───
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

  // ─── Voice / Image handlers ───
  const handleVoiceItemsIdentified = (identifiedItems: IdentifiedItem[]) => {
    const newItems: ServiceCartItem[] = identifiedItems.map((item) => {
      const tool = userTools.find(t => t.id === item.userToolId);
      const servico = servicos.find(s => s.omie_codigo_servico === item.omie_codigo_servico) || null;
      return {
        type: 'service' as const,
        userTool: tool!,
        servico,
        quantity: item.quantity,
        notes: item.notes,
        photos: [],
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

  const obenSubtotal = useMemo(() => obenProductItems.reduce((s, c) => s + c.quantity * c.unit_price, 0), [obenProductItems]);
  const colacorProdSubtotal = useMemo(() => colacorProductItems.reduce((s, c) => s + c.quantity * c.unit_price, 0), [colacorProductItems]);
  const serviceSubtotal = useMemo(() => {
    return serviceItems.reduce((s, c) => {
      const price = getServicePrice(c);
      return s + (price !== null ? price * c.quantity : 0);
    }, 0);
  }, [serviceItems]);
  const totalEstimated = obenSubtotal + colacorProdSubtotal + serviceSubtotal;

  // Filtered products per tab
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

  // Recommendation handler
  const handleAddRecommendation = useCallback((item: RecommendationItem) => {
    const allProducts = [...obenProducts, ...colacorProducts];
    const product = allProducts.find(p => p.id === item.product_id);
    if (product) addProductToCart(product);
  }, [obenProducts, colacorProducts]);

  // ─── Create local profile ───
  const handleStaffAddTool = async () => {
    if (!selectedCustomer) return;
    if (customerUserId) { setAddToolDialogOpen(true); return; }
    setCreatingLocalProfile(true);
    try {
      // Try omie_clientes mapping first
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
      // Fallback: search by document in profiles (handles cross-account mappings)
      if (selectedCustomer.cnpj_cpf) {
        const docClean = selectedCustomer.cnpj_cpf.replace(/\D/g, '');
        if (docClean.length >= 11) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('user_id')
            .eq('document', docClean)
            .maybeSingle();
          if (profile?.user_id) {
            setCustomerUserId(profile.user_id);
            loadUserTools(profile.user_id);
            setAddToolDialogOpen(true);
            return;
          }
        }
      }
      // No existing profile found — create one
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

    const hasObenProducts = obenProductItems.length > 0;
    const hasColacorProducts = colacorProductItems.length > 0;
    const hasServices = serviceItems.length > 0;
    const results: string[] = [];

    try {
      // 1. Oben products
      if (hasObenProducts) {
        const itemsPayload = obenProductItems.map(c => ({
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
            subtotal: obenSubtotal,
            total: obenSubtotal,
            status: 'rascunho',
            notes: notes || null,
            account: 'oben',
          } as any)
          .select('id')
          .single();

        if (insertError) throw insertError;

        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido',
            account: 'oben',
            sales_order_id: salesOrder.id,
            codigo_cliente: selectedCustomer.codigo_cliente,
            codigo_vendedor: selectedCustomer.codigo_vendedor,
            items: obenProductItems.map(c => ({
              omie_codigo_produto: c.product.omie_codigo_produto,
              quantidade: c.quantity,
              valor_unitario: c.unit_price,
            })),
            observacao: notes,
            codigo_parcela: selectedParcelaOben,
          },
        });

        if (!omieError) {
          results.push(`PV Oben ${omieResult?.omie_numero_pedido || ''}`);
        } else {
          results.push('PV Oben (pendente ERP)');
        }
      }

      // 2. Colacor products
      if (hasColacorProducts) {
        const itemsPayload = colacorProductItems.map(c => ({
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
            subtotal: colacorProdSubtotal,
            total: colacorProdSubtotal,
            status: 'rascunho',
            notes: notes || null,
            account: 'colacor',
          } as any)
          .select('id')
          .single();

        if (insertError) throw insertError;

        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido',
            account: 'colacor',
            sales_order_id: salesOrder.id,
            codigo_cliente: selectedCustomer.codigo_cliente_colacor || selectedCustomer.codigo_cliente,
            codigo_vendedor: selectedCustomer.codigo_vendedor_colacor ?? selectedCustomer.codigo_vendedor,
            items: colacorProductItems.map(c => ({
              omie_codigo_produto: c.product.omie_codigo_produto,
              quantidade: c.quantity,
              valor_unitario: c.unit_price,
            })),
            observacao: notes,
            codigo_parcela: selectedParcelaColacor,
          },
        });

        if (!omieError) {
          results.push(`PV Colacor ${omieResult?.omie_numero_pedido || ''}`);
        } else {
          results.push('PV Colacor (pendente ERP)');
        }
      }

      // 3. Services (Afiação)
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
            category: c.servico?.descricao || '',
            quantity: c.quantity,
            omie_codigo_servico: c.servico?.omie_codigo_servico,
            userToolId: c.userTool.id,
            toolName: getToolName(c.userTool),
            notes: c.notes,
            photos: c.photos || [],
            unitPrice: price || 0,
            toolCategoryId: c.userTool.tool_category_id,
            toolSpecs: c.userTool.specifications || {},
          };
        });

        const selectedAddressData = addresses.find(a => a.id === selectedAddress);
        const addressPayload = selectedAddressData ? {
          street: selectedAddressData.street,
          number: selectedAddressData.number,
          complement: selectedAddressData.complement || undefined,
          neighborhood: selectedAddressData.neighborhood,
          city: selectedAddressData.city,
          state: selectedAddressData.state,
          zip_code: selectedAddressData.zipCode,
        } : undefined;

        const orderData = {
          items: orderItems,
          service_type: 'padrao',
          subtotal: serviceSubtotal,
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

  // Product table render helper
  const renderProductTable = (prods: Product[], prices: Record<number, number>, loading: boolean) => (
    <>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Buscar produto..." value={productSearch} onChange={e => setProductSearch(e.target.value)} className="pl-9 h-9" />
      </div>
      {loading ? (
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
              {prods.map(product => {
                const isInCart = productItems.some(c => c.product.id === product.id);
                const customerPrice = prices[product.omie_codigo_produto];
                return (
                  <tr key={product.id} className={cn('border-b last:border-b-0 hover:bg-muted/20 transition-colors', isInCart && 'bg-accent/20')}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
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
    </>
  );

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Novo Pedido</h1>
          <p className="text-xs text-muted-foreground">Produtos Oben, Colacor e Afiação em um único pedido.</p>
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
                <div className="space-y-3">
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
                      setCustomerPricesOben({});
                      setCustomerPricesColacor({});
                      setCart([]);
                      setCustomerUserId(null);
                      setUserTools([]);
                      setSelectedParcelaOben('999');
                      setSelectedParcelaColacor('999');
                      setVendedorDivergencias([]);
                      setAddresses([]);
                      setSelectedAddress('');
                    }}>
                      Trocar
                    </Button>
                  </div>

                  {validatingVendedor && (
                    <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">Validando vendedor nos 3 Omies...</p>
                    </div>
                  )}

                  {vendedorDivergencias.length > 0 && (
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="text-xs font-semibold text-destructive">Vendedor divergente entre contas Omie</p>
                          <p className="text-xs text-muted-foreground mt-1">Corrija no Omie antes de prosseguir:</p>
                          <ul className="text-xs mt-1 space-y-0.5">
                            {vendedorDivergencias.map((d, i) => (
                              <li key={i} className="text-destructive font-medium">• {d}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}
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

          {/* 2. Tabbed catalog: Oben / Colacor / Afiação */}
          {selectedCustomer && (
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-3">
              <TabsList className="w-full grid grid-cols-3">
                <TabsTrigger value="oben" className="gap-1">
                  <Building2 className="w-3.5 h-3.5" />
                  Oben
                  {obenProductItems.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{obenProductItems.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="colacor" className="gap-1">
                  <Building2 className="w-3.5 h-3.5" />
                  Colacor
                  {colacorProductItems.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{colacorProductItems.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="services" className="gap-1">
                  <Scissors className="w-3.5 h-3.5" />
                  Afiação
                  {serviceItems.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{serviceItems.length}</Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              {/* Oben Products Tab */}
              <TabsContent value="oben">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Package className="w-4 h-4" /> Produtos Oben
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {renderProductTable(filteredObenProducts, customerPricesOben, loadingObenProducts)}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Colacor Products Tab */}
              <TabsContent value="colacor">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Package className="w-4 h-4" /> Produtos Colacor
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {renderProductTable(filteredColacorProducts, customerPricesColacor, loadingColacorProducts)}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Services Tab (Afiação) - FULL FEATURES */}
              <TabsContent value="services">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Wrench className="w-4 h-4" /> Afiação — Ferramentas do Cliente
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
                      <div className="space-y-4">
                        {/* Voice & Image assistants */}
                        <div className="space-y-3">
                          <VoiceServiceInput
                            userTools={userTools}
                            onItemsIdentified={handleVoiceItemsIdentified}
                            isLoading={submitting}
                          />
                          <ToolImageIdentifier
                            categories={toolCategories}
                            onCategoryIdentified={handleImageCategoryIdentified}
                          />
                        </div>

                        {/* Service items in cart */}
                        {serviceItems.length > 0 && (
                          <div className="space-y-4">
                            {serviceItems.map((item) => {
                              const filteredSvcs = getFilteredServicos(item.userTool);
                              const cartIdx = cart.indexOf(item);
                              const price = getServicePrice(item);
                              return (
                                <div key={item.userTool.id} className="border rounded-xl p-4 bg-accent/10 space-y-3">
                                  <div className="flex items-start justify-between">
                                    <div className="flex items-center gap-2">
                                      <Wrench className="w-4 h-4 text-primary" />
                                      <span className="text-sm font-medium">{getToolName(item.userTool)}</span>
                                    </div>
                                    <button onClick={() => removeFromCart(cartIdx)}>
                                      <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                                    </button>
                                  </div>

                                  {/* Service selection */}
                                  <div>
                                    <label className="text-xs font-medium mb-1 block">Tipo de serviço *</label>
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
                                  </div>

                                  {/* Quantity */}
                                  <div>
                                    <label className="text-xs font-medium mb-1 block">
                                      Quantidade
                                      <span className="text-muted-foreground ml-1">(máx: {item.userTool.quantity || 1})</span>
                                    </label>
                                    <div className="flex items-center gap-3">
                                      <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => updateQuantity(cartIdx, -1)}>
                                        <Minus className="w-3 h-3" />
                                      </Button>
                                      <span className="w-8 text-center font-semibold">{item.quantity}</span>
                                      <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => {
                                        const maxQty = item.userTool.quantity || 1;
                                        if (item.quantity >= maxQty) {
                                          toast({ title: 'Quantidade máxima atingida', description: `Esta ferramenta possui apenas ${maxQty} unidade(s).` });
                                          return;
                                        }
                                        updateQuantity(cartIdx, 1);
                                      }}>
                                        <Plus className="w-3 h-3" />
                                      </Button>
                                      {price !== null && (
                                        <span className="text-xs text-primary font-medium ml-auto">{fmt(price * item.quantity)}</span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Notes */}
                                  <div>
                                    <label className="text-xs font-medium mb-1 block">Observações (opcional)</label>
                                    <textarea
                                      value={item.notes || ''}
                                      onChange={e => updateServiceNotes(item.userTool.id, e.target.value)}
                                      placeholder="Descreva danos, lascados, ou instruções especiais..."
                                      className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-none"
                                      rows={2}
                                    />
                                  </div>

                                  {/* Photos */}
                                  {customerUserId && (
                                    <div>
                                      <label className="text-xs font-medium mb-1 block">Fotos (opcional)</label>
                                      <PhotoUpload
                                        photos={item.photos || []}
                                        onPhotosChange={(photos) => updateServicePhotos(item.userTool.id, photos)}
                                        userId={customerUserId}
                                        maxPhotos={3}
                                      />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Available tools to add */}
                        {availableTools.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-2">
                              {serviceItems.length > 0 ? 'Adicionar mais ferramentas:' : 'Ferramentas cadastradas:'}
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

                        {/* Delivery section for afiação */}
                        {serviceItems.length > 0 && (
                          <div className="border-t pt-4 space-y-4">
                            <h3 className="text-sm font-semibold flex items-center gap-2">
                              <MapPin className="w-4 h-4" /> Entrega da Afiação
                            </h3>

                            <div className="bg-primary/10 border border-primary/20 rounded-lg p-3">
                              <p className="text-xs text-primary font-medium">✓ Frete grátis em todas as modalidades</p>
                            </div>

                            <div className="space-y-2">
                              {Object.entries(DELIVERY_OPTIONS).map(([key, { label, description }]) => (
                                <button
                                  key={key}
                                  onClick={() => setDeliveryOption(key as DeliveryOption)}
                                  className={cn(
                                    'w-full p-3 rounded-lg border-2 text-left transition-all flex items-start gap-2',
                                    deliveryOption === key ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                                  )}
                                >
                                  <div className={cn(
                                    'w-4 h-4 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0',
                                    deliveryOption === key ? 'border-primary' : 'border-muted-foreground'
                                  )}>
                                    {deliveryOption === key && <div className="w-2 h-2 rounded-full bg-primary" />}
                                  </div>
                                  <div className="flex-1">
                                    <span className="text-sm font-medium block">{label}</span>
                                    <span className="text-xs text-muted-foreground">{description}</span>
                                  </div>
                                </button>
                              ))}
                            </div>

                            {deliveryOption !== 'balcao' && (
                              <>
                                {/* Address */}
                                {addresses.length > 0 ? (
                                  <div>
                                    <label className="text-xs font-medium mb-2 flex items-center gap-1">
                                      <MapPin className="w-3 h-3" /> Endereço
                                    </label>
                                    {(() => {
                                      const addr = addresses.find(a => a.id === selectedAddress);
                                      if (!addr) return null;
                                      return (
                                        <div className="bg-card rounded-lg p-3 border-2 border-primary">
                                          <div className="flex items-start justify-between">
                                            <div>
                                              <span className="text-xs font-semibold">{addr.label}</span>
                                              <p className="text-xs text-muted-foreground">
                                                {addr.street}, {addr.number}{addr.complement && ` - ${addr.complement}`}
                                              </p>
                                              <p className="text-xs text-muted-foreground">
                                                {addr.neighborhood} - {addr.city}/{addr.state}
                                              </p>
                                            </div>
                                            <Check className="w-4 h-4 text-primary" />
                                          </div>
                                        </div>
                                      );
                                    })()}
                                    {!showAddressOptions && addresses.length > 1 && (
                                      <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => setShowAddressOptions(true)}>
                                        Alterar endereço
                                      </Button>
                                    )}
                                    {showAddressOptions && addresses.filter(a => a.id !== selectedAddress).map(addr => (
                                      <button
                                        key={addr.id}
                                        onClick={() => { setSelectedAddress(addr.id); setShowAddressOptions(false); }}
                                        className="w-full mt-2 p-3 rounded-lg border-2 border-border text-left hover:border-primary/50 transition-all"
                                      >
                                        <span className="text-xs font-semibold">{addr.label}</span>
                                        <p className="text-xs text-muted-foreground">
                                          {addr.street}, {addr.number} - {addr.city}/{addr.state}
                                        </p>
                                      </button>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-xs text-muted-foreground">Nenhum endereço cadastrado para este cliente.</p>
                                )}

                                {/* Time slot */}
                                <div>
                                  <label className="text-xs font-medium mb-2 flex items-center gap-1">
                                    <Clock className="w-3 h-3" /> Horário preferido
                                  </label>
                                  <div className="grid grid-cols-2 gap-2">
                                    {TIME_SLOTS.map(slot => (
                                      <button
                                        key={slot.id}
                                        onClick={() => setSelectedTimeSlot(slot.id)}
                                        className={cn(
                                          'py-2 px-3 rounded-lg border-2 text-xs font-medium transition-all',
                                          selectedTimeSlot === slot.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                                        )}
                                      >
                                        {slot.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </>
                            )}

                            {/* Payment for afiação */}
                            <div>
                              <label className="text-xs font-medium mb-2 block">Pagamento Afiação</label>
                              <div className="space-y-1.5">
                                {PAYMENT_OPTIONS.map(option => (
                                  <button
                                    key={option.id}
                                    onClick={() => setAfiacaoPaymentMethod(option.id)}
                                    className={cn(
                                      'w-full p-2.5 rounded-lg border-2 text-left transition-all',
                                      afiacaoPaymentMethod === option.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                                    )}
                                  >
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <span className="text-xs font-medium">{option.label}</span>
                                        <p className="text-[10px] text-muted-foreground">{option.description}</p>
                                      </div>
                                      {afiacaoPaymentMethod === option.id && <Check className="w-3.5 h-3.5 text-primary" />}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
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
                  {/* Oben Products */}
                  {obenProductItems.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        <Building2 className="w-3 h-3 inline mr-1" />Oben
                      </p>
                      {obenProductItems.map(item => {
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

                  {/* Colacor Products */}
                  {colacorProductItems.length > 0 && (
                    <div>
                      {obenProductItems.length > 0 && <Separator className="my-2" />}
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        <Building2 className="w-3 h-3 inline mr-1" />Colacor Produtos
                      </p>
                      {colacorProductItems.map(item => {
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
                      {(obenProductItems.length > 0 || colacorProductItems.length > 0) && <Separator className="my-2" />}
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        <Scissors className="w-3 h-3 inline mr-1" />Afiação
                      </p>
                      {serviceItems.map(item => {
                        const price = getServicePrice(item);
                        return (
                          <div key={item.userTool.id} className="mb-1.5">
                            <div className="flex items-center justify-between">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium truncate">{getToolName(item.userTool)}</p>
                                <p className="text-[10px] text-muted-foreground truncate">
                                  {item.quantity}x {item.servico?.descricao || 'Selecione serviço'}
                                </p>
                                {item.notes && <p className="text-[10px] text-muted-foreground italic truncate">Obs: {item.notes}</p>}
                              </div>
                              {price !== null ? (
                                <span className="text-xs font-semibold shrink-0">{fmt(price * item.quantity)}</span>
                              ) : (
                                <span className="text-[10px] text-muted-foreground italic shrink-0">A orçar</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {/* Delivery info in cart */}
                      <div className="mt-1.5 pt-1.5 border-t border-dashed">
                        <p className="text-[10px] text-muted-foreground">
                          📦 {DELIVERY_OPTIONS[deliveryOption].label}
                          {deliveryOption !== 'balcao' && selectedTimeSlot && (
                            <> • {TIME_SLOTS.find(s => s.id === selectedTimeSlot)?.label}</>
                          )}
                        </p>
                      </div>
                    </div>
                  )}

                  <Separator />

                  {/* Totals */}
                  {obenProductItems.length > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Oben</span>
                      <span className="font-medium">{fmt(obenSubtotal)}</span>
                    </div>
                  )}
                  {colacorProductItems.length > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Colacor Prod.</span>
                      <span className="font-medium">{fmt(colacorProdSubtotal)}</span>
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
                    {obenProductItems.length > 0 && <Badge variant="outline" className="text-[9px]"><Building2 className="w-2.5 h-2.5 mr-0.5" />Oben</Badge>}
                    {colacorProductItems.length > 0 && <Badge variant="outline" className="text-[9px]"><Building2 className="w-2.5 h-2.5 mr-0.5" />Colacor</Badge>}
                    {serviceItems.length > 0 && <Badge variant="outline" className="text-[9px]"><Scissors className="w-2.5 h-2.5 mr-0.5" />Afiação</Badge>}
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
                {obenProductItems.length > 0 && (
                  <div>
                    <Label className="text-xs font-medium">Pagamento Oben</Label>
                    {loadingFormas ? (
                      <Loader2 className="w-4 h-4 animate-spin mt-1" />
                    ) : (
                      <Select value={selectedParcelaOben} onValueChange={setSelectedParcelaOben}>
                        <SelectTrigger className="text-sm h-9 mt-1">
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent>
                          {sortedFormasPagamentoOben.map(f => (
                            <SelectItem key={f.codigo} value={f.codigo}>
                              {customerParcelaRankingOben.includes(f.codigo) ? '⭐ ' : ''}{f.descricao}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}

                {colacorProductItems.length > 0 && (
                  <div>
                    <Label className="text-xs font-medium">Pagamento Colacor</Label>
                    {loadingFormas ? (
                      <Loader2 className="w-4 h-4 animate-spin mt-1" />
                    ) : (
                      <Select value={selectedParcelaColacor} onValueChange={setSelectedParcelaColacor}>
                        <SelectTrigger className="text-sm h-9 mt-1">
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent>
                          {sortedFormasPagamentoColacor.map(f => (
                            <SelectItem key={f.codigo} value={f.codigo}>
                              {customerParcelaRankingColacor.includes(f.codigo) ? '⭐ ' : ''}{f.descricao}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}

                <div>
                  <Label className="text-xs font-medium">Observações gerais</Label>
                  <Textarea placeholder="Observações do pedido..." value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="text-sm mt-1" />
                </div>

                {serviceItems.some(s => !s.servico) && (
                  <p className="text-xs text-amber-600">
                    <AlertCircle className="w-3 h-3 inline mr-1" />
                    Selecione o serviço para cada ferramenta na aba Afiação.
                  </p>
                )}

                <Button
                  className="w-full gap-2"
                  onClick={submitOrder}
                  disabled={submitting || serviceItems.some(s => !s.servico) || vendedorDivergencias.length > 0}
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Enviar pedido
                  {(() => {
                    const count = (obenProductItems.length > 0 ? 1 : 0) + (colacorProductItems.length > 0 ? 1 : 0) + (serviceItems.length > 0 ? 1 : 0);
                    return count > 1 ? <span className="text-[10px] opacity-70">({count} pedidos)</span> : null;
                  })()}
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
          categories={toolCategories}
          targetUserId={customerUserId}
          onToolAdded={() => loadUserTools(customerUserId)}
        />
      )}
    </div>
  );
};

export default UnifiedOrder;
