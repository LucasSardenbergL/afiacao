import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, ShoppingCart, Plus, Package, Trash2, Building2, Wrench, Share2, Printer, Pencil, Search, ChevronLeft } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Checkbox } from '@/components/ui/checkbox';
import { BulkActionsBar } from '@/components/ui/bulk-actions-bar';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';
import { StatusBadgeSimple } from '@/components/StatusBadge';
import type { OrderStatus } from '@/types';
import { shareOrderViaWhatsApp } from '@/utils/whatsappShare';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';

type SalesOrderRow = Tables<'sales_orders'>;
type AfiacaoOrderRow = Tables<'orders'>;
type ProfileRow = Tables<'profiles'>;

// Shape de cada item dentro de orders.items (jsonb). Só os campos consumidos aqui.
interface AfiacaoItemRaw {
  category?: string | null;
  name?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
}

// Cache do useInfiniteQuery de sales_orders — usado nos rollbacks optimistic.
type SalesOrdersInfiniteCache = InfiniteData<SalesOrder[]>;

// Inclui colacor_sc — antes ficava de fora da Tabs e os pedidos do SC só apareciam
// na aba "Todos". 'afiacao' é virtual (representa o módulo Afiação, sem coluna
// account na tabela orders) e não vem do CompanyContext.
type Account = 'oben' | 'colacor' | 'colacor_sc' | 'afiacao' | 'all';

const PAGE_SIZE = 50;

const decodeHtml = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: Array<{ descricao: string; quantidade: number; valor_unitario: number; valor_total: number }>;
  subtotal: number;
  total: number;
  status: string;
  omie_numero_pedido: string | null;
  omie_pedido_id: number | null;
  created_at: string;
  notes: string | null;
  account?: string;
  _source?: 'sales' | 'afiacao';
}

const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  rascunho: { label: 'Rascunho', variant: 'outline' },
  enviado: { label: 'Enviado ao Omie', variant: 'default' },
  faturado: { label: 'Faturado', variant: 'secondary' },
  cancelado: { label: 'Cancelado', variant: 'destructive' },
  recebido: { label: 'Recebido', variant: 'default' },
  em_analise: { label: 'Em Análise', variant: 'default' },
  em_producao: { label: 'Em Produção', variant: 'default' },
  pronto: { label: 'Pronto', variant: 'secondary' },
  entregue: { label: 'Entregue', variant: 'secondary' },
};

const SalesOrders = () => {
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

  /* ─── Profiles (nomes dos clientes) ─── */
  const customerIds = useMemo(() => [...new Set(orders.map((o) => o.customer_user_id))], [orders]);
  const profilesQuery = useQuery({
    queryKey: ['sales-orders-profiles', customerIds.sort().join(',')],
    enabled: isStaff && customerIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', customerIds);
      const map: Record<string, string> = {};
      ((data || []) as Pick<ProfileRow, 'user_id' | 'name'>[]).forEach((p) => {
        map[p.user_id] = p.name ?? '';
      });
      return map;
    },
  });
  const profiles = profilesQuery.data || {};

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

  const loading = salesQuery.isLoading || afiacaoQuery.isLoading;

  // Soft-delete + Omie exclude. Fluxo:
  // 1. Optimistic remove do cache (UI atualiza instantaneamente)
  // 2. UPDATE sales_orders SET deleted_at = now() (audit trail compliance)
  // 3. Call Omie excluir_pedido
  // 4. Se Omie falhar: rollback do soft-delete + restaura cache
  // 5. Se Supabase update falhar: rollback do cache, NÃO chama Omie
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

    // 1. Soft-delete local primeiro (audit trail antes do Omie)
    // `deleted_at` existe no DB mas ainda não no generated Database type — cast as never
    const { error: softErr } = await supabase
      .from('sales_orders')
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq('id', order.id);

    if (softErr) {
      console.error(softErr);
      queryClient.setQueryData(['sales-orders-paginated'], snapshot);
      toast.error('Erro ao excluir pedido', { description: softErr.message });
      return;
    }

    // 2. Omie exclude — se falhar, rollback do soft-delete
    try {
      const { error } = await supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'excluir_pedido',
          sales_order_id: order.id,
          omie_pedido_id: order.omie_pedido_id,
        },
      });
      if (error) throw error;
      toast.success('Pedido excluído');
    } catch (e) {
      console.error(e);
      // Rollback do soft-delete (deleted_at = null) — pedido volta a ser ativo
      await supabase
        .from('sales_orders')
        .update({ deleted_at: null } as never)
        .eq('id', order.id);
      queryClient.setQueryData(['sales-orders-paginated'], snapshot);
      toast.error('Erro ao excluir pedido', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
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
      .update({ deleted_at: nowIso } as never)
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
        .update({ deleted_at: null } as never)
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
    let result = accountFilter === 'all'
      ? orders
      : accountFilter === 'afiacao'
        ? orders.filter(o => o._source === 'afiacao')
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

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center pt-32">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Pedidos</h1>
          <p className="text-xs text-muted-foreground">Gerencie todos os seus pedidos de venda e afiação</p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button onClick={() => navigate('/sales/new')} className="gap-2 flex-1">
          <Plus className="w-4 h-4" />
          Novo Pedido
        </Button>
        <Button variant="outline" onClick={() => navigate('/sales/products')} className="gap-2">
          <Package className="w-4 h-4" />
          Catálogo
        </Button>
        <Button variant="outline" onClick={() => navigate('/sales/print')} className="gap-2">
          <Printer className="w-4 h-4" />
          Imprimir
        </Button>
      </div>

      {/* Account Filter */}
      <Tabs value={accountFilter} onValueChange={(v) => setAccountFilter(v as Account)}>
         <TabsList className="w-full grid grid-cols-5">
          <TabsTrigger value="all">Todos</TabsTrigger>
          <TabsTrigger value="oben" className="gap-1">
            <Building2 className="w-3 h-3" />
            Oben
          </TabsTrigger>
          <TabsTrigger value="colacor" className="gap-1">
            <Building2 className="w-3 h-3" />
            Colacor
          </TabsTrigger>
          <TabsTrigger value="colacor_sc" className="gap-1">
            <Building2 className="w-3 h-3" />
            Colacor SC
          </TabsTrigger>
          <TabsTrigger value="afiacao" className="gap-1">
            <Wrench className="w-3 h-3" />
            Afiação
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por cliente, nº pedido ou item..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {filteredOrders.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title={search.trim() || accountFilter !== 'all' ? 'Nenhum pedido com esses filtros' : 'Nenhum pedido ainda'}
          description={
            search.trim() || accountFilter !== 'all'
              ? 'Tente ajustar a busca ou trocar a aba de empresa.'
              : 'Crie seu primeiro pedido pra começar a operar.'
          }
          actionLabel={search.trim() || accountFilter !== 'all' ? 'Limpar filtros' : 'Novo pedido'}
          onAction={() => {
            if (search.trim() || accountFilter !== 'all') {
              setSearch('');
              setAccountFilter('all');
            } else {
              navigate('/sales/new');
            }
          }}
        />
      ) : (
        <div className="space-y-2">
          {filteredOrders.map((order) => {
            const isAfiacao = order._source === 'afiacao';
            const status = statusLabels[order.status] || statusLabels.rascunho;
            const totalItems = order.items?.reduce((s, i) => s + (i.quantidade || 0), 0) || 0;
            const orderAccount = isAfiacao ? 'afiacao' : (order.account || 'oben');
            const accountLabel = isAfiacao
              ? 'Afiação'
              : orderAccount === 'colacor_sc'
                ? 'Colacor SC'
                : orderAccount === 'colacor'
                  ? 'Colacor'
                  : 'Oben';
            const isSelectable = !isAfiacao; // só sales_orders são bulk-deletáveis
            const checked = selectedIds.has(order.id);
            return (
              <Card key={`${order._source}-${order.id}`} className={`cursor-pointer hover:bg-muted/30 transition-colors ${checked ? 'ring-2 ring-foreground/20' : ''}`} onClick={() => isAfiacao ? navigate(`/orders/${order.id}`) : undefined}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    {isSelectable && (
                      <Checkbox
                        checked={checked}
                        onClick={(e) => e.stopPropagation()}
                        onCheckedChange={(v) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(order.id);
                            else next.delete(order.id);
                            return next;
                          });
                        }}
                        className="mt-0.5"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="font-medium text-sm truncate">
                          {decodeHtml(profiles[order.customer_user_id] || 'Cliente')}
                        </p>
                        <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                          {accountLabel}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(order.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                      </p>
                      {order.omie_numero_pedido && (
                        <p className="text-xs text-muted-foreground">
                          PV: <span className="font-tabular text-foreground">{order.omie_numero_pedido.replace(/^0+/, '') || '0'}</span>
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0 space-y-1">
                      {isAfiacao ? (
                        <StatusBadgeSimple status={order.status as OrderStatus} size="sm" />
                      ) : (
                        <Badge variant={status.variant}>{status.label}</Badge>
                      )}
                      <p className="text-sm font-bold">R$ {order.total.toFixed(2)}</p>
                      <p className="text-xs text-muted-foreground">{totalItems} itens</p>
                      <div className="flex gap-1 justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleShareOrder(order, decodeHtml(profiles[order.customer_user_id] || 'Cliente'));
                          }}
                          title="Compartilhar via WhatsApp"
                        >
                          <Share2 className="w-3.5 h-3.5" />
                        </Button>
                        {!isAfiacao && !['cancelado', 'entregue', 'faturado'].includes(order.status) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/sales/edit/${order.id}`);
                            }}
                            title="Editar pedido"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {!isAfiacao && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={(e) => e.stopPropagation()}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Excluir pedido?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Esta ação não pode ser desfeita. O pedido será removido permanentemente do sistema.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                <AlertDialogAction onClick={() => deleteOrder(order)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                                  Excluir
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {/* Infinite scroll sentinel + carregar mais fallback */}
          {hasNext && (
            <div ref={sentinelRef} className="py-4 flex justify-center">
              {isFetching ? (
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (salesQuery.hasNextPage) salesQuery.fetchNextPage();
                    if (afiacaoQuery.hasNextPage) afiacaoQuery.fetchNextPage();
                  }}
                >
                  Carregar mais
                </Button>
              )}
            </div>
          )}
          {!hasNext && orders.length >= PAGE_SIZE && (
            <p className="text-center text-xs text-muted-foreground py-4">
              Todos os pedidos carregados ({orders.length})
            </p>
          )}
        </div>
      )}

      {/* Barra flutuante quando há seleção múltipla */}
      <BulkActionsBar
        count={selectedIds.size}
        onClear={() => setSelectedIds(new Set())}
        itemSingular="pedido"
        itemPlural="pedidos"
        actions={[
          {
            id: 'delete',
            label: 'Excluir',
            icon: Trash2,
            variant: 'destructive',
            onClick: () => {
              if (confirm(`Excluir ${selectedIds.size} pedido(s)? Esta ação não pode ser desfeita.`)) {
                deleteSelected();
              }
            },
          },
        ]}
      />
    </div>
  );
};

export default SalesOrders;
