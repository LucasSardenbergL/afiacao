import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { TintColorSelectDialog } from '@/components/TintColorSelectDialog';
import type { Product } from '@/hooks/useUnifiedOrder';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, Save, Trash2, Plus, AlertCircle, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface OrderItem {
  product_id?: string;
  omie_codigo_produto: number;
  codigo?: string;
  descricao: string;
  unidade?: string;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
  tint_cor_id?: string;
  tint_nome_cor?: string;
}

interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: OrderItem[];
  subtotal: number;
  total: number;
  status: string;
  notes: string | null;
  account: string;
  omie_pedido_id: number | null;
  omie_numero_pedido: string | null;
  omie_payload: any;
  created_at: string;
}

interface OmieProduct {
  id: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  account?: string;
  is_tintometric?: boolean;
  tint_type?: string;
}

const BLOCKED_STATUSES = ['cancelado', 'entregue', 'faturado'];

const SalesOrderEdit = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isStaff } = useAuth();

  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [items, setItems] = useState<OrderItem[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formas, setFormas] = useState<Array<{ codigo: string; descricao: string }>>([]);
  const [selectedParcela, setSelectedParcela] = useState('');

  // Add product state
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [catalogProducts, setCatalogProducts] = useState<OmieProduct[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);

  useEffect(() => {
    if (id) loadOrder();
  }, [id]);

  const loadOrder = async () => {
    try {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      const o = data as any as SalesOrder;
      setOrder(o);
      setItems(o.items || []);
      setNotes(o.notes || '');
      const parcela = o.omie_payload?.cabecalho?.codigo_parcela;
      if (parcela) setSelectedParcela(parcela);

      const { data: profile } = await supabase
        .from('profiles')
        .select('name')
        .eq('user_id', o.customer_user_id)
        .single();
      if (profile) setCustomerName(profile.name || '');

      const account = o.account === 'colacor' ? 'colacor' : 'oben';
      
      // Load formas + products in parallel
      const [formasRes, productsRes] = await Promise.all([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_formas_pagamento', account },
        }),
        supabase.from('omie_products')
          .select('id, omie_codigo_produto, codigo, descricao, unidade, valor_unitario')
          .eq('account', account === 'colacor' ? 'colacor_vendas' : 'oben')
          .eq('ativo', true)
          .order('descricao')
          .limit(1000),
      ]);

      if (formasRes.data?.formas) setFormas(formasRes.data.formas);
      if (productsRes.data) setCatalogProducts(productsRes.data as OmieProduct[]);
    } catch (e) {
      console.error(e);
      toast.error('Erro ao carregar pedido');
    } finally {
      setLoading(false);
    }
  };

  const updateItem = (index: number, field: 'quantidade' | 'valor_unitario', value: number) => {
    setItems(prev => prev.map((item, i) => {
      if (i !== index) return item;
      const updated = { ...item, [field]: value };
      updated.valor_total = updated.quantidade * updated.valor_unitario;
      return updated;
    }));
  };

  const removeItem = (index: number) => {
    if (items.length <= 1) {
      toast.error('O pedido precisa ter pelo menos 1 item');
      return;
    }
    setItems(prev => prev.filter((_, i) => i !== index));
  };

  const addProduct = (product: OmieProduct) => {
    // Check if already in items
    const exists = items.some(i => i.omie_codigo_produto === product.omie_codigo_produto);
    if (exists) {
      toast.error('Este produto já está no pedido');
      return;
    }
    const newItem: OrderItem = {
      product_id: product.id,
      omie_codigo_produto: product.omie_codigo_produto,
      codigo: product.codigo,
      descricao: product.descricao,
      unidade: product.unidade || 'UN',
      quantidade: 1,
      valor_unitario: product.valor_unitario || 0,
      valor_total: product.valor_unitario || 0,
    };
    setItems(prev => [...prev, newItem]);
    setShowAddProduct(false);
    setProductSearch('');
    toast.success(`"${product.descricao}" adicionado`);
  };

  const filteredProducts = useMemo(() => {
    if (!productSearch || productSearch.length < 2) return [];
    const q = productSearch.toLowerCase();
    return catalogProducts.filter(p =>
      p.descricao?.toLowerCase().includes(q) || p.codigo?.toLowerCase().includes(q)
    ).slice(0, 20);
  }, [productSearch, catalogProducts]);

  const subtotal = items.reduce((s, i) => s + i.valor_total, 0);

  const handleSave = async () => {
    if (!order) return;
    if (items.length === 0) {
      toast.error('O pedido precisa ter pelo menos 1 item');
      return;
    }
    setSaving(true);
    try {
      const account = order.account === 'colacor' ? 'colacor' : 'oben';

      if (order.omie_pedido_id) {
        const { data: result, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'alterar_pedido',
            account,
            sales_order_id: order.id,
            items: items.map(i => ({
              product_id: i.product_id,
              omie_codigo_produto: i.omie_codigo_produto,
              codigo: i.codigo,
              descricao: i.descricao,
              unidade: i.unidade,
              quantidade: i.quantidade,
              valor_unitario: i.valor_unitario,
              ...(i.tint_cor_id ? { tint_cor_id: i.tint_cor_id, tint_nome_cor: i.tint_nome_cor } : {}),
            })),
            observacao: notes,
            codigo_parcela: selectedParcela || undefined,
          },
        });
        if (error) throw error;
        toast.success('Pedido alterado no Omie com sucesso!');
      } else {
        const { error } = await supabase
          .from('sales_orders')
          .update({
            items: items as any,
            subtotal,
            total: subtotal,
            notes: notes || null,
          } as any)
          .eq('id', order.id);
        if (error) throw error;
        toast.success('Pedido atualizado localmente');
      }

      navigate('/sales');
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || 'Erro ao salvar pedido');
    } finally {
      setSaving(false);
    }
  };

  const isBlocked = order ? BLOCKED_STATUSES.includes(order.status) : false;

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Editar Pedido" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Pedido não encontrado" showBack />
        <div className="flex items-center justify-center pt-32">
          <p className="text-muted-foreground">Pedido não encontrado</p>
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-32">
      <Header title="Editar Pedido" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
        {/* Order Info */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>📦 {customerName || 'Cliente'}</span>
              <Badge variant="outline">{order.account === 'colacor' ? 'Colacor' : 'Oben'}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-1">
            {order.omie_numero_pedido && <p>PV: {order.omie_numero_pedido}</p>}
            <p>Status: {order.status}</p>
          </CardContent>
        </Card>

        {isBlocked && (
          <Card className="border-destructive">
            <CardContent className="p-4 flex items-center gap-2 text-destructive">
              <AlertCircle className="w-5 h-5" />
              <p className="text-sm font-medium">
                Este pedido está com status "{order.status}" e não pode ser editado.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Items */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>Itens do Pedido</span>
              {!isBlocked && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => setShowAddProduct(!showAddProduct)}
                >
                  {showAddProduct ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                  {showAddProduct ? 'Fechar' : 'Adicionar'}
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Add product search */}
            {showAddProduct && !isBlocked && (
              <div className="border rounded-lg p-3 bg-muted/30 space-y-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Buscar produto por nome ou código..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    className="pl-8 h-8 text-sm"
                    autoFocus
                  />
                </div>
                {filteredProducts.length > 0 && (
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {filteredProducts.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addProduct(p)}
                        className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-wrap break-words">{p.descricao}</p>
                          <p className="text-xs text-muted-foreground">{p.codigo} • {p.unidade}</p>
                        </div>
                        <span className="text-xs font-medium shrink-0">
                          R$ {(p.valor_unitario || 0).toFixed(2)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {productSearch.length >= 2 && filteredProducts.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">Nenhum produto encontrado</p>
                )}
                {productSearch.length < 2 && (
                  <p className="text-xs text-muted-foreground text-center py-1">Digite pelo menos 2 caracteres</p>
                )}
              </div>
            )}

            {items.map((item, index) => (
              <div key={index} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.descricao}</p>
                    {item.codigo && <p className="text-xs text-muted-foreground">Cód: {item.codigo}</p>}
                    {item.tint_nome_cor && (
                      <p className="text-xs text-muted-foreground">
                        🎨 {item.tint_cor_id} - {item.tint_nome_cor}
                      </p>
                    )}
                  </div>
                  {!isBlocked && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => removeItem(index)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground">Qtd</label>
                    <Input
                      type="number"
                      min={1}
                      value={item.quantidade}
                      onChange={(e) => updateItem(index, 'quantidade', Number(e.target.value) || 1)}
                      disabled={isBlocked}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Valor Unit.</label>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={item.valor_unitario}
                      onChange={(e) => updateItem(index, 'valor_unitario', Number(e.target.value) || 0)}
                      disabled={isBlocked}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Total</label>
                    <p className="h-8 flex items-center text-sm font-medium">
                      R$ {item.valor_total.toFixed(2)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Forma de Pagamento */}
        {formas.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Forma de Pagamento</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={selectedParcela} onValueChange={setSelectedParcela} disabled={isBlocked}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecionar parcela" />
                </SelectTrigger>
                <SelectContent>
                  {formas.map((f) => (
                    <SelectItem key={f.codigo} value={f.codigo}>
                      {f.descricao}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        )}

        {/* Notes */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Observações</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isBlocked}
              rows={3}
              placeholder="Observações do pedido..."
            />
          </CardContent>
        </Card>

        {/* Financial Summary */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-lg font-bold">
              <span>Total</span>
              <span>R$ {subtotal.toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Save Button */}
        {!isBlocked && (
          <Button
            onClick={handleSave}
            disabled={saving || items.length === 0}
            className="w-full gap-2"
            size="lg"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {order.omie_pedido_id ? 'Salvar e Alterar no Omie' : 'Salvar Alterações'}
          </Button>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default SalesOrderEdit;
