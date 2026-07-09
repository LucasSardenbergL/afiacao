// Lógica da tela de edição de pedido de venda (load, edição de itens, save no Omie).
// Extraída verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import type { Tables, Json } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import type { Product } from '@/hooks/useUnifiedOrder';
import { paginateAll } from '@/hooks/unifiedOrder/catalog-helpers';
import { buildExclusionQuery } from '@/hooks/unifiedOrder/types';
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
        .select('id, customer_user_id, items, subtotal, total, status, notes, account, omie_pedido_id, omie_numero_pedido, created_at')
        .eq('id', id)
        .single();
      if (error) throw error;
      const row = data as unknown as Tables<'sales_orders'>;
      // omie_payload não é mais legível por .select() (fechado ao customer no PR0.0-bis); o staff
      // o recupera pelo canal SECDEF. Indispensável ANTES de montar o pedido: handleSave faz merge
      // {...order.omie_payload, cabecalho:{codigo_parcela}} — sem o payload atual, salvar APAGARIA
      // o resto do payload. Falha do canal ⇒ fail-closed (o pedido não carrega).
      const { data: pl, error: plErr } = await supabase.rpc(
        'staff_get_sales_order_payload' as never,
        { p_order_ids: [id] } as never,
      );
      if (plErr) throw plErr;
      const payload = ((pl as unknown as Array<{ omie_payload: OmiePayload | null }> | null)?.[0]?.omie_payload) ?? null;
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
        omie_payload: payload,
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

      // Load formas + products in parallel.
      const [formasRes, products] = await Promise.all([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_formas_pagamento', account },
        }),
        // Catálogo vendável PAGINADO (.range): o PostgREST capa em 1000 linhas/request
        // e a busca "Adicionar produto" é client-side sobre `catalogProducts` — um único
        // .limit(1000) deixaria ~1140 produtos colacor (2140 ativos) invisíveis pra venda.
        // `account` já é a conta NORMALIZADA ('colacor'|'oben'), a MESMA que
        // omie_products.account armazena (analytics-sync grava 'colacor'/'oben'; NÃO
        // re-mapear p/ 'colacor_vendas' — não existe nesta coluna → 0 vendáveis). Espelha
        // o catálogo de criação (useProductCatalog: paginateAll + buildExclusionQuery).
        paginateAll<OmieProduct>(async (from, to) => {
          const base = supabase.from('omie_products')
            .select('id, omie_codigo_produto, codigo, descricao, unidade, valor_unitario, estoque, ativo, account, is_tintometric, tint_type')
            .eq('account', account)
            .eq('ativo', true);
          const { data, error } = await buildExclusionQuery(base)
            .order('descricao')
            .order('id')
            .range(from, to);
          if (error) throw error;
          return (data ?? []) as unknown as OmieProduct[];
        }),
      ]);

      const formasData = formasRes.data as FormasPagamentoResponse | null;
      if (formasData?.formas) setFormas(formasData.formas);
      setCatalogProducts(products);
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
        }).then(({ data, error }) => {
          if (error) {
            toast.error('Erro ao sincronizar com Omie: ' + (error.message || 'Erro desconhecido'));
          } else if ((data as { blocked?: string } | null)?.blocked === 'credito') {
            // Trava Fase 2 (edge devolve 200 estruturado): o gate barrou o AUMENTO —
            // o Omie NÃO foi atualizado e o pedido local ficou à frente. Nunca
            // "sincronizado com sucesso" aqui.
            toast.error('Edição bloqueada por crédito — o Omie NÃO foi atualizado', {
              description:
                'Aumento de valor para cliente com vencido 60+ exige exceção de gestor ' +
                '(Pedidos → abrir o pedido → botão Crédito). Após aprovar, salve o pedido de novo.',
              duration: 12000,
            });
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
