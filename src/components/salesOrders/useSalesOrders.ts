// Lógica da listagem de pedidos de venda (queries paginadas, merge, optimistic delete).
// Extraída verbatim de src/pages/SalesOrders.tsx (god-component split).
import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { shareOrderViaWhatsApp } from '@/utils/whatsappShare';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import {
  PAGE_SIZE,
  decodeHtml,
  type Account,
  type SalesOrder,
  type SalesOrderRow,
  type AfiacaoOrderRow,
  type ProfileRow,
  type AfiacaoItemRaw,
  type SalesOrdersInfiniteCache,
} from './types';
import { softDeleteOrder } from './soft-delete';
import { printSalesOrder } from './print';

export function useSalesOrders() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isStaff, loading: authLoading, role } = useAuth();
  const [accountFilter, setAccountFilter] = useState<Account>('all');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!authLoading && role !== null && !isStaff) navigate('/', { replace: true });
  }, [authLoading, role, isStaff, navigate]);

  /* ─── Sales orders: infinite query (50 por página) ─── */
  const salesQuery = useInfiniteQuery({
    queryKey: ['sales-orders-paginated'],
    enabled: isStaff,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const start = (pageParam as number) * PAGE_SIZE;
      const { data, error } = await supabase
        .from('sales_orders')
        .select('*')
        // Filtra soft-deletes (deleted_at IS NOT NULL = pedido excluído).
        // Usa partial index idx_sales_orders_active em deleted_at IS NULL.
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(start, start + PAGE_SIZE - 1);
      if (error) throw error;
      return ((data || []) as SalesOrderRow[]).map((o) => ({
        ...o,
        _source: 'sales' as const,
      })) as unknown as SalesOrder[];
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length : undefined,
  });

  /* ─── Afiação orders: infinite query (50 por página) ─── */
  const afiacaoQuery = useInfiniteQuery({
    queryKey: ['afiacao-orders-paginated'],
    enabled: isStaff,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const start = (pageParam as number) * PAGE_SIZE;
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .range(start, start + PAGE_SIZE - 1);
      if (error) throw error;
      return ((data || []) as AfiacaoOrderRow[]).map((o) => {
        const rawItems = Array.isArray(o.items) ? (o.items as unknown as AfiacaoItemRaw[]) : [];
        return {
          id: o.id,
          customer_user_id: o.user_id,
          items: rawItems.map((i) => ({
            descricao: i.category || i.name || 'Afiação',
            quantidade: i.quantity || 1,
            valor_unitario: i.unitPrice || 0,
            valor_total: (i.quantity || 1) * (i.unitPrice || 0),
          })),
          subtotal: o.subtotal || o.total || 0,
          total: o.total || 0,
          status: o.status,
          omie_numero_pedido: null,
          omie_pedido_id: null,
          created_at: o.created_at,
          notes: o.notes,
          account: 'afiacao',
          _source: 'afiacao' as const,
        };
      }) as SalesOrder[];
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length : undefined,
  });

  /* ─── Lista mergeada ─── */
  const orders = useMemo<SalesOrder[]>(() => {
    const sales = salesQuery.data?.pages.flat() || [];
    const afiacao = afiacaoQuery.data?.pages.flat() || [];
    return [...sales, ...afiacao].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [salesQuery.data, afiacaoQuery.data]);

  /* ─── Profiles (nome + documento dos clientes) ─── */
  const customerIds = useMemo(() => [...new Set(orders.map((o) => o.customer_user_id))], [orders]);
  // Chave estável SEM mutar customerIds (que é usado no .in()). O .sort() in-place
  // direto na queryKey mutava o valor memoizado.
  const customerIdsKey = useMemo(() => [...customerIds].sort().join(','), [customerIds]);
  const profilesQuery = useQuery({
    queryKey: ['sales-orders-profiles', customerIdsKey],
    enabled: isStaff && customerIds.length > 0,
    staleTime: 60_000,
    // Ao paginar, os customerIds crescem → a queryKey muda → a query re-busca.
    // keepPreviousData mantém os nomes já carregados durante a nova busca, em vez
    // de esvaziar (os nomes "piscavam Cliente", a lista filtrada colapsava e o
    // scroll resetava pro topo). Causa-raiz do reset com busca ativa.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('user_id, name, document')
        .in('user_id', customerIds);
      const names: Record<string, string> = {};
      const docs: Record<string, string> = {};
      ((data || []) as Pick<ProfileRow, 'user_id' | 'name' | 'document'>[]).forEach((p) => {
        names[p.user_id] = p.name ?? '';
        if (p.document) docs[p.user_id] = p.document;
      });
      return { names, docs };
    },
  });
  const profiles = profilesQuery.data?.names || {};
  const customerDocs = profilesQuery.data?.docs || {};

  /* ─── Logos das empresas (cupom de impressão) — cache 24h, igual ao dashboard ─── */
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

  // Imprime o cupom de um pedido (mesmo layout de /sales/print).
  const printOrder = (order: SalesOrder) => {
    const name = decodeHtml(profiles[order.customer_user_id] || 'Cliente');
    printSalesOrder(order, name, customerDocs[order.customer_user_id], companyLogos);
  };

  /* ─── Infinite scroll: dispara fetchNextPage de quem ainda tem páginas ─── */
  const hasNext = !!salesQuery.hasNextPage || !!afiacaoQuery.hasNextPage;
  const isFetching = salesQuery.isFetchingNextPage || afiacaoQuery.isFetchingNextPage;
  const sentinelRef = useInfiniteScroll(
    () => {
      if (salesQuery.hasNextPage && !salesQuery.isFetchingNextPage) salesQuery.fetchNextPage();
      if (afiacaoQuery.hasNextPage && !afiacaoQuery.isFetchingNextPage) afiacaoQuery.fetchNextPage();
    },
    hasNext && !isFetching,
  );

  const loadMore = () => {
    if (salesQuery.hasNextPage) salesQuery.fetchNextPage();
    if (afiacaoQuery.hasNextPage) afiacaoQuery.fetchNextPage();
  };

  const loading = salesQuery.isLoading || afiacaoQuery.isLoading;

  // Soft-delete + Omie exclude. Cache/toast aqui; orquestração no helper softDeleteOrder.
  // 1. Optimistic remove do cache. 2. softDeleteOrder (deleted_at + Omie + rollback).
  // 3. Em falha, restaura o cache (o helper já reverteu deleted_at quando o Omie falha).
  const deleteOrder = async (order: SalesOrder) => {
    const snapshot = queryClient.getQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated']);
    queryClient.setQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated'], (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => page.filter((o) => o.id !== order.id)),
      };
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(order.id);
      return next;
    });

    const result = await softDeleteOrder(order);
    if (result.ok) {
      toast.success('Pedido excluído');
      return;
    }
    queryClient.setQueryData(['sales-orders-paginated'], snapshot);
    toast.error('Erro ao excluir pedido', { description: (result as { message: string }).message });
  };

  // Bulk delete — sequencial pra não floodar o Omie. Mostra progresso.
  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    const toDelete = orders.filter((o) => selectedIds.has(o.id) && o._source === 'sales');
    const snapshot = queryClient.getQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated']);
    const deleteIds = new Set(toDelete.map((o) => o.id));
    queryClient.setQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated'], (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => page.filter((o) => !deleteIds.has(o.id))),
      };
    });
    setSelectedIds(new Set());

    // 1. Soft-delete em batch (1 UPDATE com .in('id', ...))
    const nowIso = new Date().toISOString();
    const { error: softErr } = await supabase
      .from('sales_orders')
      .update({ deleted_at: nowIso })
      .in('id', Array.from(deleteIds));

    if (softErr) {
      console.error(softErr);
      queryClient.setQueryData(['sales-orders-paginated'], snapshot);
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
      await supabase
        .from('sales_orders')
        .update({ deleted_at: null })
        .in('id', failedIds);
    }

    if (failed === 0) {
      toast.success(`${success} pedido(s) excluído(s)`);
    } else if (success === 0) {
      queryClient.setQueryData(['sales-orders-paginated'], snapshot); // rollback completo
      toast.error(`Falhou: ${failed} pedido(s) não puderam ser excluídos`);
    } else {
      // Parcial — restaura os que falharam no cache (já temos deleted_at=null no DB)
      const failedSet = new Set(failedIds);
      queryClient.setQueryData<SalesOrdersInfiniteCache>(['sales-orders-paginated'], (old) => {
        if (!old || !snapshot) return old;
        // Pega as rows que falharam do snapshot original e reinjeta na primeira página
        const failedRows = snapshot.pages
          .flat()
          .filter((o) => failedSet.has(o.id));
        return {
          ...old,
          pages: old.pages.map((page, i) =>
            i === 0 ? [...failedRows, ...page] : page,
          ),
        };
      });
      toast.warning(`${success} excluído(s), ${failed} falharam`);
    }
  };

  const handleShareOrder = (order: SalesOrder, customerName: string) => {
    const items = (order.items || []).map(item => ({
      description: item.descricao,
      quantity: item.quantidade,
      unitPrice: item.valor_unitario,
    }));

    const orderNumbers = order.omie_numero_pedido ? [order.omie_numero_pedido.replace(/^0+/, '') || '0'] : [];

    shareOrderViaWhatsApp({
      customerName,
      items,
      total: order.total,
      orderNumbers,
      date: new Date(order.created_at),
    });
  };

  const filteredOrders = useMemo(() => {
    // Colacor SC engloba: (a) pedidos comerciais com account='colacor_sc' E
    // (b) pedidos de afiação (que operam sob a entidade SC). Afiação não é tab
    // separada, é serviço da Colacor SC.
    let result = accountFilter === 'all'
      ? orders
      : accountFilter === 'colacor_sc'
        ? orders.filter(o => o._source === 'afiacao' || (o._source === 'sales' && o.account === 'colacor_sc'))
        : orders.filter(o => o._source === 'sales' && (o.account || 'oben') === accountFilter);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(o => {
        const customerName = decodeHtml(profiles[o.customer_user_id] || '');
        const pvNumber = o.omie_numero_pedido || '';
        const itemDescs = (o.items || []).map(i => i.descricao).join(' ');
        return (
          customerName.toLowerCase().includes(q) ||
          pvNumber.toLowerCase().includes(q) ||
          itemDescs.toLowerCase().includes(q) ||
          o.total.toFixed(2).includes(q)
        );
      });
    }

    return result;
  }, [orders, accountFilter, search, profiles]);

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
    loading,
    accountFilter,
    setAccountFilter,
    search,
    setSearch,
    selectedIds,
    toggleSelect,
    clearSelection,
    orders,
    profiles,
    filteredOrders,
    hasNext,
    isFetching,
    sentinelRef,
    loadMore,
    deleteOrder,
    deleteSelected,
    handleShareOrder,
    printOrder,
  };
}
