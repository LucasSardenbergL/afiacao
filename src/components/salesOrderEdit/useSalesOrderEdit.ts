// Lógica da tela de edição de pedido de venda (load, edição de itens, save no Omie).
// Extraída verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import type { Tables, Json } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import type { Product } from '@/hooks/useUnifiedOrder';
import {
  BLOCKED_STATUSES,
  type OrderItem,
  type OmiePayload,
  type SalesOrder,
  type FormasPagamentoResponse,
  type OmieProduct,
} from './types';
import { invalidPricedOrderItemIndices, invalidOrderPriceMessage } from './priceGuard';

export function useSalesOrderEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useAuth(); // mantém o hook montado pra refresh de token; isStaff não é usado

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
  // Tint color dialog
  const [tintPendingProduct, setTintPendingProduct] = useState<OmieProduct | null>(null);
  const [customerUserId, setCustomerUserId] = useState<string | null>(null);

  useEffect(() => {
    if (id) loadOrder();
  }, [id]);

  const loadOrder = async () => {
    if (!id) return;
    try {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      const row = data as Tables<'sales_orders'>;
      const o: SalesOrder = {
        id: row.id,
        customer_user_id: row.customer_user_id,
        items: (row.items as unknown as OrderItem[]) || [],
        subtotal: row.subtotal,
        total: row.total,
        status: row.status,
        notes: row.notes,
        account: row.account,
        omie_pedido_id: row.omie_pedido_id,
        omie_numero_pedido: row.omie_numero_pedido,
        omie_payload: (row.omie_payload as unknown as OmiePayload | null) ?? null,
        created_at: row.created_at,
      };
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
      setCustomerUserId(o.customer_user_id);

      const account = o.account === 'colacor' ? 'colacor' : 'oben';

      // Load formas + products in parallel
      const [formasRes, productsRes] = await Promise.all([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_formas_pagamento', account },
        }),
        supabase.from('omie_products')
          .select('id, omie_codigo_produto, codigo, descricao, unidade, valor_unitario, estoque, ativo, account, is_tintometric, tint_type')
          .eq('account', account === 'colacor' ? 'colacor_vendas' : 'oben')
          .eq('ativo', true)
          .order('descricao')
          .limit(1000),
      ]);

      const formasData = formasRes.data as FormasPagamentoResponse | null;
      if (formasData?.formas) setFormas(formasData.formas);
      if (productsRes.data) setCatalogProducts(productsRes.data as unknown as OmieProduct[]);
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
    // If tintometric base, open color dialog
    if (product.is_tintometric && product.tint_type === 'base') {
      setTintPendingProduct(product);
      setShowAddProduct(false);
      setProductSearch('');
      return;
    }
    const exists = items.some(i => i.omie_codigo_produto === product.omie_codigo_produto && !i.tint_cor_id);
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

  const handleTintConfirm = (formulaId: string, corId: string, nomeCor: string, precoFinal: number, _custoCorantes: number, alternativeProduct?: Product) => {
    const product = alternativeProduct
      ? catalogProducts.find(p => p.id === alternativeProduct.id) || tintPendingProduct!
      : tintPendingProduct!;
    const newItem: OrderItem = {
      product_id: product.id,
      omie_codigo_produto: product.omie_codigo_produto,
      codigo: product.codigo,
      descricao: product.descricao,
      unidade: product.unidade || 'UN',
      quantidade: 1,
      valor_unitario: precoFinal,
      valor_total: precoFinal,
      tint_cor_id: corId,
      tint_nome_cor: nomeCor,
      // espelha o balcão (submitOrder.ts): grava a fórmula p/ auditoria e re-precificação.
      tint_formula_id: formulaId,
    };
    setItems(prev => [...prev, newItem]);
    setTintPendingProduct(null);
    toast.success(`"${product.descricao}" com cor ${corId} adicionado`);
  };

  const tintProductAsProduct = useMemo((): Product | null => {
    if (!tintPendingProduct) return null;
    return {
      id: tintPendingProduct.id,
      codigo: tintPendingProduct.codigo,
      descricao: tintPendingProduct.descricao,
      unidade: tintPendingProduct.unidade,
      valor_unitario: tintPendingProduct.valor_unitario,
      estoque: tintPendingProduct.estoque ?? 0,
      ativo: tintPendingProduct.ativo ?? true,
      omie_codigo_produto: tintPendingProduct.omie_codigo_produto,
      account: tintPendingProduct.account,
      is_tintometric: tintPendingProduct.is_tintometric,
      tint_type: tintPendingProduct.tint_type,
    };
  }, [tintPendingProduct]);

  const filteredProducts = useMemo(() => {
    if (!productSearch || productSearch.length < 2) return [];
    const q = productSearch.toLowerCase();
    return catalogProducts.filter(p =>
      p.descricao?.toLowerCase().includes(q) || p.codigo?.toLowerCase().includes(q)
    ).slice(0, 20);
  }, [productSearch, catalogProducts]);

  const subtotal = items.reduce((s, i) => s + i.valor_total, 0);
  // Índices dos itens com preço inválido (≤ 0 / NaN) — MESMA fonte para o bloqueio no
  // save e para o destaque na UI (aria-invalid + botão travado).
  const invalidPriceItemIndices = useMemo(() => invalidPricedOrderItemIndices(items), [items]);

  const handleSave = async () => {
    if (!order) return;
    if (items.length === 0) {
      toast.error('O pedido precisa ter pelo menos 1 item');
      return;
    }
    // Guard money-path: nenhum item de produto pode ser salvo com preço ≤ 0 (esvaziar o
    // campo vira Number("")||0 = 0). Bloqueia ANTES de qualquer update local ou sync ao
    // Omie, nos dois caminhos (com e sem omie_pedido_id) — fail-closed imperativo, não só UI.
    if (invalidPriceItemIndices.length > 0) {
      toast.error(invalidOrderPriceMessage(invalidPriceItemIndices.map((i) => items[i])));
      return;
    }
    setSaving(true);
    try {
      const account = order.account === 'colacor' ? 'colacor' : 'oben';

      if (order.omie_pedido_id) {
        // Save locally first
        const updatedPayload = {
          ...(order.omie_payload || {}),
          cabecalho: {
            ...(order.omie_payload?.cabecalho || {}),
            ...(selectedParcela ? { codigo_parcela: selectedParcela } : {}),
          },
        };
        const { error: localErr } = await supabase
          .from('sales_orders')
          .update({
            items: items as unknown as Json,
            subtotal,
            total: subtotal,
            notes: notes || null,
            omie_payload: updatedPayload as unknown as Json,
          })
          .eq('id', order.id);
        if (localErr) throw localErr;

        // Navigate immediately and sync in background
        toast.info('Pedido salvo! Sincronizando com o Omie em segundo plano...');
        navigate('/sales');

        // Fire-and-forget sync
        supabase.functions.invoke('omie-vendas-sync', {
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
        }).then(({ error }) => {
          if (error) {
            toast.error('Erro ao sincronizar com Omie: ' + (error.message || 'Erro desconhecido'));
          } else {
            toast.success('Pedido sincronizado com o Omie com sucesso!');
          }
        }).catch((err) => {
          toast.error('Erro ao sincronizar com Omie: ' + (err.message || 'Erro desconhecido'));
        });
      } else {
        const updatedPayloadLocal = {
          ...(order.omie_payload || {}),
          cabecalho: {
            ...(order.omie_payload?.cabecalho || {}),
            ...(selectedParcela ? { codigo_parcela: selectedParcela } : {}),
          },
        };
        const { error } = await supabase
          .from('sales_orders')
          .update({
            items: items as unknown as Json,
            subtotal,
            total: subtotal,
            notes: notes || null,
            omie_payload: updatedPayloadLocal as unknown as Json,
          })
          .eq('id', order.id);
        if (error) throw error;
        toast.success('Pedido atualizado localmente');
        navigate('/sales');
      }
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : 'Erro ao salvar pedido';
      toast.error(message);
      setSaving(false);
    }
  };

  const isBlocked = order ? BLOCKED_STATUSES.includes(order.status) : false;

  return {
    order,
    customerName,
    items,
    notes,
    setNotes,
    loading,
    saving,
    formas,
    selectedParcela,
    setSelectedParcela,
    showAddProduct,
    setShowAddProduct,
    productSearch,
    setProductSearch,
    tintPendingProduct,
    setTintPendingProduct,
    customerUserId,
    updateItem,
    removeItem,
    addProduct,
    handleTintConfirm,
    tintProductAsProduct,
    filteredProducts,
    subtotal,
    invalidPriceItemIndices,
    handleSave,
    isBlocked,
  };
}
