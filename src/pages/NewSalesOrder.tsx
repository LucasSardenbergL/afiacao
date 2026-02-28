import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RecommendationsPanel } from '@/components/RecommendationsPanel';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';
import {
  Loader2, Search, Plus, Minus, Trash2, User, ShoppingCart, Send, CreditCard,
  ChevronLeft, Package, TrendingUp, Sparkles, ArrowUpRight, CheckCircle, Building2, AlertTriangle,
} from 'lucide-react';

/* ─── Types ─── */
type Account = 'oben' | 'colacor';

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

interface CartItem {
  product: Product;
  quantity: number;
  unit_price: number;
}

interface OmieCustomer {
  codigo_cliente: number;
  razao_social: string;
  nome_fantasia: string;
  cnpj_cpf: string;
  codigo_vendedor: number | null;
}

interface SelectedCustomer {
  name: string;
  document: string;
  omie_codigo_cliente: number;
  omie_codigo_vendedor: number | null;
}

interface FormaPagamento {
  codigo: string;
  descricao: string;
}

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function normalizeStr(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
}

/* ─── Stepper ─── */
function OrderStepper({ step }: { step: number }) {
  const steps = ['Cliente', 'Produtos', 'Revisão'];
  return (
    <div className="flex items-center gap-2 mb-4">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div className={cn(
            'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
            i < step ? 'bg-primary text-primary-foreground' :
            i === step ? 'bg-primary text-primary-foreground' :
            'bg-muted text-muted-foreground'
          )}>
            {i < step ? <CheckCircle className="w-3.5 h-3.5" /> : i + 1}
          </div>
          <span className={cn(
            'text-xs font-medium',
            i <= step ? 'text-foreground' : 'text-muted-foreground'
          )}>{s}</span>
          {i < steps.length - 1 && (
            <div className={cn('w-8 h-px', i < step ? 'bg-primary' : 'bg-border')} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── Main Component ─── */
const NewSalesOrder = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  // Account selector
  const [account, setAccount] = useState<Account>('oben');

  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<OmieCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null);
  const [loadingCustomer, setLoadingCustomer] = useState(false);
  const [searchingCustomers, setSearchingCustomers] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [colacorProducts, setColacorProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [loadingProducts, setLoadingProducts] = useState(true);

  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [formasPagamento, setFormasPagamento] = useState<FormaPagamento[]>([]);
  const [selectedParcela, setSelectedParcela] = useState<string>('999');
  const [loadingFormas, setLoadingFormas] = useState(false);

  const [customerPrices, setCustomerPrices] = useState<Record<number, number>>({});

  // Vendedor validation
  const [vendedorDivergencias, setVendedorDivergencias] = useState<string[]>([]);
  const [validatingVendedor, setValidatingVendedor] = useState(false);

  // Customer user_id for recommendation engine
  const [customerUserId, setCustomerUserId] = useState<string | null>(null);

  // Cart product IDs for contextual recommendations
  const cartProductIds = useMemo(() => cart.map(c => c.product.id), [cart]);

  // Handle adding a recommended product to cart
  const handleAddRecommendation = useCallback((item: RecommendationItem) => {
    const allProducts = [...products, ...colacorProducts];
    const product = allProducts.find(p => p.id === item.product_id);
    if (product) {
      addToCart(product);
    }
  }, [products, colacorProducts]);

  const currentStep = !selectedCustomer ? 0 : cart.length === 0 ? 1 : 2;

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (isStaff) {
      loadProducts();
      loadFormasPagamento();
    }
  }, [isStaff, account]);

  // Also load Colacor products for cross-match when on Oben
  useEffect(() => {
    if (isStaff && account === 'oben') {
      loadColacorProducts();
    } else {
      setColacorProducts([]);
    }
  }, [isStaff, account]);

  const loadProducts = async () => {
    setLoadingProducts(true);
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
          setProducts((refreshed || []) as Product[]);
        } catch (syncErr) {
          console.error('Erro ao sincronizar produtos:', syncErr);
        }
      } else {
        setProducts(data as Product[]);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingProducts(false);
    }
  };

  const loadColacorProducts = async () => {
    try {
      const { data } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account')
        .eq('account', 'colacor')
        .not('familia', 'ilike', '%imobilizado%')
        .not('familia', 'ilike', '%uso e consumo%')
        .not('familia', 'ilike', '%matérias primas para conversão de cintas%')
        .not('familia', 'ilike', '%jumbos de lixa para discos%')
        .not('familia', 'ilike', '%material para tingimix%')
        .gt('estoque', 0)
        .order('descricao');
      setColacorProducts((data || []) as Product[]);
    } catch (e) {
      console.error('Erro ao carregar produtos Colacor:', e);
    }
  };

  // Build cross-match map: normalized Oben description -> Colacor product with stock
  const colacorMatchMap = useMemo(() => {
    const map: Record<string, Product> = {};
    for (const cp of colacorProducts) {
      const key = normalizeStr(cp.descricao);
      if (!map[key] || cp.estoque > (map[key].estoque || 0)) {
        map[key] = cp;
      }
    }
    return map;
  }, [colacorProducts]);

  const findColacorMatch = useCallback((descricao: string): Product | null => {
    const key = normalizeStr(descricao);
    return colacorMatchMap[key] || null;
  }, [colacorMatchMap]);

  useEffect(() => {
    if (customerSearch.length < 2) { setCustomers([]); return; }
    const timeout = setTimeout(async () => {
      setSearchingCustomers(true);
      try {
        const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_clientes', search: customerSearch, account },
        });
        if (!error && data?.clientes) setCustomers(data.clientes);
      } catch (e) { console.error(e); }
      finally { setSearchingCustomers(false); }
    }, 500);
    return () => clearTimeout(timeout);
  }, [customerSearch, account]);

  const loadFormasPagamento = async () => {
    setLoadingFormas(true);
    try {
      const { data } = await supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'listar_formas_pagamento', account },
      });
      if (data?.formas) setFormasPagamento(data.formas);
    } catch (e) { console.error(e); }
    finally { setLoadingFormas(false); }
  };

  const selectCustomer = async (cust: OmieCustomer) => {
    setLoadingCustomer(true);
    setCustomerSearch('');
    setCustomers([]);
    setVendedorDivergencias([]);
    try {
      const custData = {
        name: cust.nome_fantasia || cust.razao_social,
        document: cust.cnpj_cpf,
        omie_codigo_cliente: cust.codigo_cliente,
        omie_codigo_vendedor: cust.codigo_vendedor,
      };
      setSelectedCustomer(custData);

      // Find user_id from omie_clientes for recommendation engine
      const { data: omieMapping } = await supabase
        .from('omie_clientes')
        .select('user_id')
        .eq('omie_codigo_cliente', cust.codigo_cliente)
        .maybeSingle();
      if (omieMapping?.user_id) setCustomerUserId(omieMapping.user_id);
      const [priceResult, parcelaResult] = await Promise.all([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_precos_cliente', codigo_cliente: cust.codigo_cliente, account },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente, account },
        }),
      ]);
      if (priceResult.data?.precos) setCustomerPrices(priceResult.data.precos);
      if (parcelaResult.data?.ultima_parcela) setSelectedParcela(parcelaResult.data.ultima_parcela);
    } catch (error: any) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    } finally {
      setLoadingCustomer(false);
    }

    // Validate vendedor across all 3 Omie accounts
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

  const getProductPrice = useCallback((product: Product): number => {
    const omiePrice = customerPrices[product.omie_codigo_produto];
    if (omiePrice && omiePrice > 0) return omiePrice;
    return product.valor_unitario;
  }, [customerPrices]);

  const addToCart = (product: Product) => {
    const existing = cart.find(c => c.product.id === product.id);
    if (existing) {
      setCart(cart.map(c => c.product.id === product.id ? { ...c, quantity: c.quantity + 1 } : c));
    } else {
      setCart([...cart, { product, quantity: 1, unit_price: getProductPrice(product) }]);
    }
  };

  const updateQuantity = (productId: string, delta: number) => {
    setCart(cart.map(c => {
      if (c.product.id !== productId) return c;
      const newQty = c.quantity + delta;
      return newQty > 0 ? { ...c, quantity: newQty } : c;
    }));
  };

  const updatePrice = (productId: string, price: number) => {
    setCart(cart.map(c => c.product.id === productId ? { ...c, unit_price: price } : c));
  };

  const removeFromCart = (productId: string) => {
    setCart(cart.filter(c => c.product.id !== productId));
  };

  const subtotal = useMemo(() => cart.reduce((sum, c) => sum + c.quantity * c.unit_price, 0), [cart]);

  const filteredProducts = useMemo(() => {
    const sorted = [...products].sort((a, b) => {
      if (a.ativo !== b.ativo) return a.ativo ? -1 : 1;
      return a.descricao.localeCompare(b.descricao);
    });
    if (!productSearch) return sorted.slice(0, 30);
    return sorted.filter(p =>
      p.descricao.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.codigo.toLowerCase().includes(productSearch.toLowerCase())
    ).slice(0, 30);
  }, [products, productSearch]);

  // When switching account, reset customer and cart
  const handleAccountChange = (newAccount: string) => {
    if (newAccount === account) return;
    setAccount(newAccount as Account);
    setSelectedCustomer(null);
    setCustomerPrices({});
    setCart([]);
    setSelectedParcela('999');
    setCustomerUserId(null);
  };

  const submitOrder = async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    setSubmitting(true);
    try {
      const itemsPayload = cart.map(c => ({
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
          customer_user_id: user.id,
          created_by: user.id,
          items: itemsPayload,
          subtotal, total: subtotal,
          status: 'rascunho', notes,
          account,
        } as any)
        .select('id').single();
      if (insertError) throw insertError;

      const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'criar_pedido',
          account,
          sales_order_id: salesOrder.id,
          codigo_cliente: selectedCustomer.omie_codigo_cliente,
          codigo_vendedor: selectedCustomer.omie_codigo_vendedor,
          items: cart.map(c => ({
            omie_codigo_produto: c.product.omie_codigo_produto,
            quantidade: c.quantity,
            valor_unitario: c.unit_price,
          })),
          observacao: notes,
          codigo_parcela: selectedParcela,
        },
      });

      if (omieError) {
        toast({ title: 'Pedido criado localmente', description: 'Erro ao enviar ao ERP.', variant: 'destructive' });
      } else {
        toast({ title: 'Pedido enviado!', description: `Pedido ${omieResult?.omie_numero_pedido || ''} criado.` });
      }
      navigate('/sales');
    } catch (error: any) {
      toast({ title: 'Erro ao criar pedido', description: error.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/sales')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-lg font-semibold">Novo pedido de venda</h1>
              <p className="text-xs text-muted-foreground">Selecione empresa, cliente, adicione produtos e envie.</p>
            </div>
          </div>
        </div>

        {/* Account Selector */}
        <Tabs value={account} onValueChange={handleAccountChange}>
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="oben" className="gap-1.5">
              <Building2 className="w-3.5 h-3.5" />
              Oben
            </TabsTrigger>
            <TabsTrigger value="colacor" className="gap-1.5">
              <Building2 className="w-3.5 h-3.5" />
              Colacor
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <OrderStepper step={currentStep} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left: Main flow */}
          <div className="lg:col-span-2 space-y-4">
            {/* 1. Customer */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <User className="w-4 h-4" /> Cliente
                  <Badge variant="outline" className="text-[10px] ml-auto">{account === 'oben' ? 'Oben' : 'Colacor'}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {selectedCustomer ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{selectedCustomer.name}</p>
                        <p className="text-xs text-muted-foreground">{selectedCustomer.document}</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => { setSelectedCustomer(null); setCustomerPrices({}); setCart([]); setSelectedParcela('999'); setVendedorDivergencias([]); }}>
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

            {/* 2. Products */}
            {selectedCustomer && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Package className="w-4 h-4" /> Catálogo
                    <Badge variant="outline" className="text-[10px] ml-auto">{account === 'oben' ? 'Oben' : 'Colacor'}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder="Buscar produto por nome ou código..." value={productSearch} onChange={e => setProductSearch(e.target.value)} className="pl-9 h-9" />
                  </div>
                  {loadingProducts ? (
                    <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b bg-muted/30">
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Produto</th>
                            <th className="text-right px-3 py-2 font-medium text-muted-foreground">Preço</th>
                            <th className="text-center px-3 py-2 font-medium text-muted-foreground">Estoque</th>
                            <th className="w-10"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredProducts.map(product => {
                            const isInCart = cart.some(c => c.product.id === product.id);
                            const customerPrice = customerPrices[product.omie_codigo_produto];
                            const colacorMatch = account === 'oben' ? findColacorMatch(product.descricao) : null;
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
                                  {colacorMatch && (
                                    <button
                                      className="flex items-center gap-1 mt-0.5"
                                      onClick={() => addToCart(colacorMatch)}
                                      title={`Adicionar ${colacorMatch.descricao} da Colacor ao carrinho`}
                                    >
                                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-amber-500 text-amber-700 bg-amber-50 hover:bg-amber-100 cursor-pointer">
                                        <Building2 className="w-2.5 h-2.5 mr-0.5" />
                                        Colacor Est: {colacorMatch.estoque}
                                      </Badge>
                                    </button>
                                  )}
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
                                  <Button size="sm" variant={isInCart ? 'secondary' : 'ghost'} className="h-7 w-7 p-0" onClick={() => addToCart(product)}>
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
            )}
          </div>

          {/* Right: Cart sidebar */}
          <div className="space-y-4">
            {/* Cart */}
            <Card className="sticky top-20">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ShoppingCart className="w-4 h-4" />
                  Carrinho
                  {cart.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{cart.length}</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {cart.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">Nenhum item adicionado</p>
                ) : (
                  <div className="space-y-3">
                    {cart.map(item => (
                      <div key={item.product.id} className="space-y-1.5">
                        <div className="flex items-start justify-between gap-1.5">
                          <div className="flex-1">
                            <p className="text-xs font-medium leading-tight">{item.product.descricao}</p>
                            {item.product.account && item.product.account !== account && (
                              <Badge variant="outline" className="text-[8px] px-1 py-0 mt-0.5 border-amber-500 text-amber-700">
                                {item.product.account === 'colacor' ? 'Colacor' : 'Oben'}
                              </Badge>
                            )}
                          </div>
                          <button onClick={() => removeFromCart(item.product.id)} className="shrink-0" aria-label="Remover item">
                            <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive transition-colors" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-0.5">
                            <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => updateQuantity(item.product.id, -1)}>
                              <Minus className="w-3 h-3" />
                            </Button>
                            <span className="text-xs w-6 text-center font-medium">{item.quantity}</span>
                            <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => updateQuantity(item.product.id, 1)}>
                              <Plus className="w-3 h-3" />
                            </Button>
                          </div>
                          <div className="flex items-center gap-0.5 flex-1">
                            <span className="text-[10px] text-muted-foreground">R$</span>
                            <Input type="number" step="0.01" value={item.unit_price} onChange={e => updatePrice(item.product.id, parseFloat(e.target.value) || 0)} className="h-6 text-xs" />
                          </div>
                          <span className="text-xs font-semibold shrink-0">{fmt(item.quantity * item.unit_price)}</span>
                        </div>
                      </div>
                    ))}

                    <Separator />

                    <div className="flex justify-between items-center">
                      <span className="text-sm font-bold">Total</span>
                      <span className="text-sm font-bold">{fmt(subtotal)}</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* AI Recommendations */}
            {customerUserId && cart.length > 0 && (
              <RecommendationsPanel
                customerId={customerUserId}
                basketProductIds={cartProductIds}
                onAddToCart={handleAddRecommendation}
                title="Combine com"
                compact
                maxItems={5}
              />
            )}

            {/* Payment + Notes + Submit */}
            {cart.length > 0 && selectedCustomer && (
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div>
                    <Label className="text-xs font-medium">Forma de pagamento</Label>
                    {loadingFormas ? (
                      <Loader2 className="w-4 h-4 animate-spin mt-1" />
                    ) : (
                      <Select value={selectedParcela} onValueChange={setSelectedParcela}>
                        <SelectTrigger className="text-sm h-9 mt-1">
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent>
                          {formasPagamento.map(f => (
                            <SelectItem key={f.codigo} value={f.codigo}>{f.descricao}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Observações</Label>
                    <Textarea placeholder="Observações do pedido..." value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="text-sm mt-1" />
                  </div>
                  <Button className="w-full gap-2" onClick={submitOrder} disabled={submitting || vendedorDivergencias.length > 0}>
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Enviar pedido ({account === 'oben' ? 'Oben' : 'Colacor'})
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
    </div>
  );
};

export default NewSalesOrder;
