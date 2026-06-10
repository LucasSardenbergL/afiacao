// Lógica da listagem de pedidos de venda — sobre a view order_feed (read model
// único): UMA query carrega o conjunto completo (~550 pedidos) e busca/abas
// filtram client-side sobre TUDO.
//
// Antes eram 2 useInfiniteQuery (sales_orders + orders) mescladas no cliente +
// uma 3ª query de profiles — a busca só enxergava as páginas carregadas e dizia
// "Nenhum pedido" pra pedidos que existiam (reproduzido em prod), a ordem global
// quebrava ao paginar e os nomes piscavam. Spec:
// docs/superpowers/specs/2026-06-06-order-feed-view-unificada-design.md
import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { shareOrderViaWhatsApp } from '@/utils/whatsappShare';
import {
  type Account,
  type OrderFeedCache,
  type OrderFeedRow,
} from './types';
import { dedupeFeedRows, filterFeedRows } from './feed';
import { fetchOrderDetail, orderDetailQueryKey } from './useSalesOrderDetail';
import { softDeleteOrder } from './soft-delete';
import { printSalesOrder } from './print';

// O PostgREST capa cada resposta em 1000 linhas → a query drena em páginas até o
// count (medido em prod: ~2.660 pedidos ≈ 3 requests). Teto de sanidade de
// FEED_MAX_PAGES (5.000 linhas): acima disso a listagem trunca e a UI avisa
// (truncated) em vez de silenciar — é o gatilho pra migrar a busca pro servidor
// (fase 2 do spec).
const FEED_PAGE_SIZE = 1000;
const FEED_MAX_PAGES = 5;
export const FEED_MAX_TOTAL = FEED_PAGE_SIZE * FEED_MAX_PAGES;

export function useSalesOrders() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, isStaff, loading: authLoading, role } = useAuth();
  const [accountFilter, setAccountFilter] = useState<Account>('all');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!authLoading && role !== null && !isStaff) navigate('/', { replace: true });
  }, [authLoading, role, isStaff, navigate]);

  /* ─── Feed unificado: 1 query, conjunto completo ─── */
  // userId na key: troca de sessão não serve cache do usuário anterior.
  const feedKey = useMemo(() => ['order-feed', user?.id] as const, [user?.id]);
  const feedQuery = useQuery<OrderFeedCache>({
    queryKey: feedKey,
    enabled: isStaff && !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const all: OrderFeedRow[] = [];
      let total = 0;
      for (let page = 0; page < FEED_MAX_PAGES; page++) {
        const from = page * FEED_PAGE_SIZE;
        const { data, error, count } = await supabase
          .from('order_feed' as never)
          .select('*', { count: 'exact' })
          .order('created_at', { ascending: false, nullsFirst: false })
          .order('origin', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + FEED_PAGE_SIZE - 1);
        if (error) throw error;
        const rows = (data ?? []) as unknown as OrderFeedRow[];
        all.push(...rows);
        total = count ?? all.length;
        // Fim real: alcançou o count ou a página veio parcial/vazia.
        if (all.length >= total || rows.length < FEED_PAGE_SIZE) break;
      }
      return { rows: dedupeFeedRows(all), count: total };
    },
  });

  const orders = useMemo(() => feedQuery.data?.rows ?? [], [feedQuery.data]);
  const totalCount = feedQuery.data?.count ?? 0;
  // Aviso honesto de truncamento (nunca silenciar — "mostrando 1000 de N").
  const truncated = totalCount > orders.length;

  const filteredOrders = useMemo(
    () => filterFeedRows(orders, search, accountFilter),
    [orders, search, accountFilter],
  );

  /* ─── Logos das empresas (cupom de impressão) — cache 24h ─── */
  const logosQuery = useQuery({
    queryKey: ['sales-orders-company-logos'],
    enabled: isStaff,
    staleTime: 1000 * 60 * 60 * 24,
    queryFn: async () => {
      try {
        const { data } = await supabase.functions.invoke('omie-cliente', {
          body: { action: 'buscar_logos_empresas' },
        });
        return (data?.logos || {}) as Record<string, string | null>;
      } catch {
        return {};
      }
    },
  });
  const companyLogos = logosQuery.data || {};

  /* ─── Detalhe sob demanda (cache compartilhado com o painel via queryKey) ─── */
  const getDetail = (row: Pick<OrderFeedRow, 'origin' | 'id'>) =>
    queryClient.fetchQuery({
      queryKey: orderDetailQueryKey(user?.id, row.origin, row.id),
      queryFn: () => fetchOrderDetail(row.origin, row.id),
      staleTime: 60_000,
    });

  // Imprime o cupom (mesmo layout de /sales/print). Espera o detalhe completo
  // (itens com codigo/unidade/tint, payload de parcelas, endereço) ANTES de abrir.
  const printOrder = async (row: OrderFeedRow) => {
    try {
      const d = await getDetail(row);
      printSalesOrder(d.order, d.customerName, d.customerDocument, companyLogos);
    } catch (e) {
      console.error(e);
      toast.error('Não foi possível carregar o pedido para imprimir');
    }
  };

  const handleShareOrder = async (row: OrderFeedRow) => {
    try {
      const d = await getDetail(row);
      const items = (d.order.items || []).map((item) => ({
        description: item.descricao,
        quantity: item.quantidade,
        unitPrice: item.valor_unitario,
      }));
      const orderNumbers = d.order.omie_numero_pedido
        ? [d.order.omie_numero_pedido.replace(/^0+/, '') || '0']
        : [];
      shareOrderViaWhatsApp({
        customerName: d.customerName,
        items,
        total: d.order.total,
        orderNumbers,
        date: new Date(d.order.created_at),
      });
    } catch (e) {
      console.error(e);
      toast.error('Não foi possível carregar o pedido para compartilhar');
    }
  };

  /* ─── Soft-delete + Omie exclude (optimistic no cache do feed) ─── */
  const deleteOrder = async (row: OrderFeedRow) => {
    const snapshot = queryClient.getQueryData<OrderFeedCache>(feedKey);
    queryClient.setQueryData<OrderFeedCache>(feedKey, (old) =>
      old
        ? {
            rows: old.rows.filter((r) => !(r.origin === 'sales' && r.id === row.id)),
            count: Math.max(0, old.count - 1),
          }
        : old,
    );
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });

    const result = await softDeleteOrder({ id: row.id, omie_pedido_id: row.omie_pedido_id });
    if (result.ok) {
      toast.success('Pedido excluído');
      return;
    }
    queryClient.setQueryData(feedKey, snapshot);
    toast.error('Erro ao excluir pedido', { description: (result as { message: string }).message });
  };

  // Bulk delete — sequencial pra não floodar o Omie. Mostra progresso.
  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    const toDelete = orders.filter((r) => selectedIds.has(r.id) && r.origin === 'sales');
    const snapshot = queryClient.getQueryData<OrderFeedCache>(feedKey);
    const deleteIds = new Set(toDelete.map((o) => o.id));
    queryClient.setQueryData<OrderFeedCache>(feedKey, (old) =>
      old
        ? {
            rows: old.rows.filter((r) => !(r.origin === 'sales' && deleteIds.has(r.id))),
            count: Math.max(0, old.count - deleteIds.size),
          }
        : old,
    );
    setSelectedIds(new Set());

    // 1. Soft-delete em batch (1 UPDATE com .in('id', ...))
    const nowIso = new Date().toISOString();
    const { error: softErr } = await supabase
      .from('sales_orders')
      .update({ deleted_at: nowIso })
      .in('id', Array.from(deleteIds));

    if (softErr) {
      console.error(softErr);
      queryClient.setQueryData(feedKey, snapshot);
      toast.error(`Erro ao excluir pedidos`, { description: softErr.message });
      return;
    }

    // 2. Omie exclude sequencial (não floodar). Rollback do deleted_at em falhas.
    const failedIds: string[] = [];
    let success = 0;
    for (const o of toDelete) {
      try {
        const { error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'excluir_pedido',
            sales_order_id: o.id,
            omie_pedido_id: o.omie_pedido_id,
          },
        });
        if (error) throw error;
        success++;
      } catch (e) {
        failedIds.push(o.id);
        console.error(e);
      }
    }
    const failed = failedIds.length;

    // Rollback do soft-delete só pros que falharam no Omie
    if (failedIds.length > 0) {
      await supabase.from('sales_orders').update({ deleted_at: null }).in('id', failedIds);
    }

    if (failed === 0) {
      toast.success(`${success} pedido(s) excluído(s)`);
    } else if (success === 0) {
      queryClient.setQueryData(feedKey, snapshot); // rollback completo
      toast.error(`Falhou: ${failed} pedido(s) não puderam ser excluídos`);
    } else {
      // Parcial — restaura no cache as rows que falharam (já têm deleted_at=null no DB)
      const failedSet = new Set(failedIds);
      queryClient.setQueryData<OrderFeedCache>(feedKey, (old) => {
        if (!old || !snapshot) return old;
        const failedRows = snapshot.rows.filter((r) => r.origin === 'sales' && failedSet.has(r.id));
        const rows = [...old.rows, ...failedRows].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        return { rows, count: old.count + failedRows.length };
      });
      toast.warning(`${success} excluído(s), ${failed} falharam`);
    }
  };

  const toggleSelect = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  return {
    navigate,
    authLoading,
    loading: feedQuery.isLoading,
    loadError: feedQuery.isError,
    refetch: feedQuery.refetch,
    accountFilter,
    setAccountFilter,
    search,
    setSearch,
    selectedIds,
    toggleSelect,
    clearSelection,
    orders,
    filteredOrders,
    totalCount,
    truncated,
    deleteOrder,
    deleteSelected,
    handleShareOrder,
    printOrder,
  };
}
