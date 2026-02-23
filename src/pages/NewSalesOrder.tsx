import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import {
  Loader2, Search, Plus, Minus, Trash2, User, ShoppingCart, Send, CreditCard,
} from 'lucide-react';

interface Product {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  omie_codigo_produto: number;
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

const NewSalesOrder = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  // Customer selection
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<OmieCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null);
  const [loadingCustomer, setLoadingCustomer] = useState(false);
  const [searchingCustomers, setSearchingCustomers] = useState(false);

  // Products
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [loadingProducts, setLoadingProducts] = useState(true);

  // Cart
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Payment
  const [formasPagamento, setFormasPagamento] = useState<FormaPagamento[]>([]);
  const [selectedParcela, setSelectedParcela] = useState<string>('999');
  const [loadingFormas, setLoadingFormas] = useState(false);

  // Customer price history from Omie
  const [customerPrices, setCustomerPrices] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (isStaff) loadProducts();
  }, [isStaff]);

  const loadProducts = async () => {
    try {
      const { data } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, omie_codigo_produto')
        .eq('ativo', true)
        .order('descricao');
      
      if (!data || data.length === 0) {
        // Auto-sync products from Omie in chunks
        console.log('Nenhum produto local, sincronizando do Omie...');
        try {
          let nextPage: number | null = 1;
          let totalSynced = 0;
          while (nextPage) {
            const { data: syncResult, error: syncError } = await supabase.functions.invoke('omie-vendas-sync', {
              body: { action: 'sync_products', start_page: nextPage },
            });
            if (syncError) throw syncError;
            console.log(`Sync chunk: página ${syncResult.lastPage}/${syncResult.totalPaginas}, ${syncResult.totalSynced} produtos`);
            totalSynced += syncResult.totalSynced || 0;
            nextPage = syncResult.nextPage || null;
          }
          console.log(`Sync completo: ${totalSynced} produtos sincronizados`);
          // Reload after sync
          const { data: refreshed } = await supabase
            .from('omie_products')
            .select('id, codigo, descricao, unidade, valor_unitario, estoque, omie_codigo_produto')
            .eq('ativo', true)
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

  // Search customers from Omie Vendas API
  useEffect(() => {
    if (customerSearch.length < 2) {
      setCustomers([]);
      return;
    }
    const timeout = setTimeout(async () => {
      setSearchingCustomers(true);
      try {
        const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_clientes', search: customerSearch },
        });
        if (!error && data?.clientes) {
          setCustomers(data.clientes);
        }
      } catch (e) {
        console.error('Erro ao buscar clientes:', e);
      } finally {
        setSearchingCustomers(false);
      }
    }, 500);
    return () => clearTimeout(timeout);
  }, [customerSearch]);

  // Load payment methods on mount
  useEffect(() => {
    if (isStaff) loadFormasPagamento();
  }, [isStaff]);

  const loadFormasPagamento = async () => {
    setLoadingFormas(true);
    try {
      const { data } = await supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'listar_formas_pagamento' },
      });
      if (data?.formas) {
        setFormasPagamento(data.formas);
      }
    } catch (e) {
      console.error('Erro ao carregar formas de pagamento:', e);
    } finally {
      setLoadingFormas(false);
    }
  };

  // Select customer from Omie results
  const selectCustomer = async (cust: OmieCustomer) => {
    setLoadingCustomer(true);
    setCustomerSearch('');
    setCustomers([]);

    try {
      const selected: SelectedCustomer = {
        name: cust.nome_fantasia || cust.razao_social,
        document: cust.cnpj_cpf,
        omie_codigo_cliente: cust.codigo_cliente,
        omie_codigo_vendedor: cust.codigo_vendedor,
      };
      setSelectedCustomer(selected);

      // Buscar histórico de preços e última parcela em paralelo
      const [priceResult, parcelaResult] = await Promise.all([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_precos_cliente', codigo_cliente: cust.codigo_cliente },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente },
        }),
      ]);

      if (priceResult.data?.precos) {
        setCustomerPrices(priceResult.data.precos);
      }
      if (parcelaResult.data?.ultima_parcela) {
        setSelectedParcela(parcelaResult.data.ultima_parcela);
      }
    } catch (error: any) {
      console.error(error);
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    } finally {
      setLoadingCustomer(false);
    }
  };



  // Get price for a product for the selected customer
  const getProductPrice = useCallback((product: Product): number => {
    // Priority: customer's last purchase price from Omie
    const omiePrice = customerPrices[product.omie_codigo_produto];
    if (omiePrice && omiePrice > 0) return omiePrice;
    // Fallback: default product price
    return product.valor_unitario;
  }, [customerPrices]);

  // Add product to cart
  const addToCart = (product: Product) => {
    const existing = cart.find((c) => c.product.id === product.id);
    if (existing) {
      setCart(cart.map((c) =>
        c.product.id === product.id ? { ...c, quantity: c.quantity + 1 } : c
      ));
    } else {
      setCart([...cart, { product, quantity: 1, unit_price: getProductPrice(product) }]);
    }
  };

  const updateQuantity = (productId: string, delta: number) => {
    setCart(cart.map((c) => {
      if (c.product.id !== productId) return c;
      const newQty = c.quantity + delta;
      return newQty > 0 ? { ...c, quantity: newQty } : c;
    }));
  };

  const updatePrice = (productId: string, price: number) => {
    setCart(cart.map((c) =>
      c.product.id === productId ? { ...c, unit_price: price } : c
    ));
  };

  const removeFromCart = (productId: string) => {
    setCart(cart.filter((c) => c.product.id !== productId));
  };

  const subtotal = useMemo(
    () => cart.reduce((sum, c) => sum + c.quantity * c.unit_price, 0),
    [cart]
  );

  const filteredProducts = useMemo(() => {
    if (!productSearch) return products.slice(0, 20);
    return products.filter(
      (p) =>
        p.descricao.toLowerCase().includes(productSearch.toLowerCase()) ||
        p.codigo.toLowerCase().includes(productSearch.toLowerCase())
    ).slice(0, 20);
  }, [products, productSearch]);

  // Submit order
  const submitOrder = async () => {
    if (!selectedCustomer || cart.length === 0 || !user) return;
    setSubmitting(true);

    try {
      // Create sales_order locally
      const itemsPayload = cart.map((c) => ({
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
          subtotal,
          total: subtotal,
          status: 'rascunho',
          notes,
        })
        .select('id')
        .single();

      if (insertError) throw insertError;

      // Send to Omie
      const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'criar_pedido',
          sales_order_id: salesOrder.id,
          codigo_cliente: selectedCustomer.omie_codigo_cliente,
          codigo_vendedor: selectedCustomer.omie_codigo_vendedor,
          items: cart.map((c) => ({
            omie_codigo_produto: c.product.omie_codigo_produto,
            quantidade: c.quantity,
            valor_unitario: c.unit_price,
          })),
          observacao: notes,
          codigo_parcela: selectedParcela,
        },
      });

      if (omieError) {
        console.error('Erro ao enviar ao Omie:', omieError);
        toast({
          title: 'Pedido criado localmente',
          description: 'O pedido foi salvo mas houve erro ao enviar ao Omie. Tente reenviar depois.',
          variant: 'destructive',
        });
      } else {
        // Save price history (skip local history since customer may not be in app)


        toast({
          title: 'Pedido de venda criado!',
          description: `Pedido ${omieResult?.omie_numero_pedido || ''} enviado ao Omie com sucesso.`,
        });
      }

      navigate('/sales');
    } catch (error: any) {
      console.error(error);
      toast({ title: 'Erro ao criar pedido', description: error.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Novo Pedido de Venda" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Novo Pedido de Venda" showBack />

      <main className="pt-16 px-4 max-w-4xl mx-auto space-y-4">
        {/* 1. Customer Selection */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <User className="w-4 h-4" />
              Cliente
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedCustomer ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{selectedCustomer.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedCustomer.document}</p>
                  {selectedCustomer.omie_codigo_vendedor && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Vendedor: {selectedCustomer.omie_codigo_vendedor}
                    </p>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setSelectedCustomer(null); setCustomerPrices({}); setCart([]); setSelectedParcela('999'); }}>
                  Trocar
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Buscar por nome ou CPF/CNPJ..."
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
                {(loadingCustomer || searchingCustomers) && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" /> Buscando clientes no Omie...
                  </div>
                )}
                {customers.length > 0 && (
                  <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
                    {customers.map((c) => (
                      <button
                        key={c.codigo_cliente}
                        className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors"
                        onClick={() => selectCustomer(c)}
                        disabled={loadingCustomer}
                      >
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

        {/* 2. Product Search + Add */}
        {selectedCustomer && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <ShoppingCart className="w-4 h-4" />
                Produtos
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar produto..."
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  className="pl-9"
                />
              </div>

              {loadingProducts ? (
                <Loader2 className="w-5 h-5 animate-spin mx-auto" />
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {filteredProducts.map((product) => {
                    const isInCart = cart.some((c) => c.product.id === product.id);
                    const customerPrice = customerPrices[product.omie_codigo_produto];
                    return (
                      <div
                        key={product.id}
                        className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-muted/50"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{product.descricao}</p>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              R$ {(customerPrice || product.valor_unitario).toFixed(2)}
                            </span>
                            {customerPrice && customerPrice !== product.valor_unitario && (
                              <Badge variant="secondary" className="text-[10px] px-1 py-0">
                                Preço cliente
                              </Badge>
                            )}
                            <Badge variant={product.estoque > 0 ? 'outline' : 'destructive'} className="text-[10px] px-1 py-0">
                              Est: {product.estoque ?? 0}
                            </Badge>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant={isInCart ? 'secondary' : 'outline'}
                          className="h-7 w-7 p-0"
                          onClick={() => addToCart(product)}
                        >
                          <Plus className="w-3 h-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 3. Cart */}
        {cart.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Carrinho ({cart.length} {cart.length === 1 ? 'item' : 'itens'})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {cart.map((item) => (
                <div key={item.product.id} className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium flex-1">{item.product.descricao}</p>
                    <button onClick={() => removeFromCart(item.product.id)}>
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => updateQuantity(item.product.id, -1)}>
                        <Minus className="w-3 h-3" />
                      </Button>
                      <span className="text-xs w-6 text-center">{item.quantity}</span>
                      <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => updateQuantity(item.product.id, 1)}>
                        <Plus className="w-3 h-3" />
                      </Button>
                    </div>
                    <div className="flex items-center gap-1">
                      <Label className="text-xs text-muted-foreground">R$</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.unit_price}
                        onChange={(e) => updatePrice(item.product.id, parseFloat(e.target.value) || 0)}
                        className="h-6 w-20 text-xs"
                      />
                    </div>
                    <span className="text-xs font-medium ml-auto">
                      R$ {(item.quantity * item.unit_price).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}

              <Separator />

              <div className="flex justify-between items-center">
                <span className="text-sm font-bold">Total</span>
                <span className="text-sm font-bold">R$ {subtotal.toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 4. Payment Method */}
        {cart.length > 0 && selectedCustomer && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <CreditCard className="w-4 h-4" />
                Forma de Pagamento
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loadingFormas ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Select value={selectedParcela} onValueChange={setSelectedParcela}>
                  <SelectTrigger className="text-sm">
                    <SelectValue placeholder="Selecione a forma de pagamento" />
                  </SelectTrigger>
                  <SelectContent>
                    {formasPagamento.map((f) => (
                      <SelectItem key={f.codigo} value={f.codigo}>
                        {f.descricao}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </CardContent>
          </Card>
        )}

        {/* 5. Notes + Submit */}
        {cart.length > 0 && selectedCustomer && (
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div>
                <Label className="text-xs">Observações</Label>
                <Textarea
                  placeholder="Observações do pedido..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="text-sm"
                />
              </div>
              <Button
                className="w-full gap-2"
                onClick={submitOrder}
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                Enviar Pedido de Venda
              </Button>
            </CardContent>
          </Card>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default NewSalesOrder;
