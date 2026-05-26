// Hook de dados/estado do AdminCustomers.
// Extraído verbatim de src/pages/AdminCustomers.tsx (god-component split):
// 2 infinite queries (clientes paginados + employee ids), loads (categorias/
// scores paginados/ferramentas/pedidos) e handlers de seleção/exclusão.
import { useState, useEffect, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import type { Customer, ToolCategory, UserTool, ClientScore, SalesOrder } from './types';

const PAGE_SIZE = 100;

export function useAdminCustomers() {
  const navigate = useNavigate();
  const { customerId } = useParams<{ customerId?: string }>();
  const { user, isStaff, loading: authLoading } = useAuth();

  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerTools, setCustomerTools] = useState<UserTool[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [scores, setScores] = useState<Map<string, ClientScore>>(new Map());
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  /* ─── Customers: infinite query (100 por página) ─── */
  // Buscamos employee_ids 1× pra filtrar client-side (defensivo — eq('is_employee', false)
  // já filtra no DB, mas mantemos a verificação contra user_roles caso o flag esteja stale)
  const employeeIdsQuery = useInfiniteQuery({
    queryKey: ['admin-customers-employee-ids'],
    enabled: isStaff,
    staleTime: 5 * 60_000,
    initialPageParam: 0,
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('user_id')
        .in('role', ['master', 'employee']);
      return new Set((data || []).map((r: { user_id: string }) => r.user_id));
    },
    getNextPageParam: () => undefined,
  });
  const employeeIds = employeeIdsQuery.data?.pages[0] || new Set<string>();

  const customersQuery = useInfiniteQuery({
    queryKey: ['admin-customers-paginated'],
    enabled: isStaff,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const start = (pageParam as number) * PAGE_SIZE;
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, email, phone, document, customer_type, created_at, requires_po')
        .eq('is_employee', false)
        .order('name')
        .range(start, start + PAGE_SIZE - 1);
      if (error) throw error;
      return (data || []) as Customer[];
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length : undefined,
  });

  // Customers visíveis (filter defensivo de employees depois do fetch — pode reduzir
  // tamanho da page mas não afeta getNextPageParam que olha o raw 100)
  const customers = useMemo<Customer[]>(() => {
    const raw = customersQuery.data?.pages.flat() || [];
    return raw.filter((p) => !employeeIds.has(p.user_id));
  }, [customersQuery.data, employeeIds]);

  const loading = customersQuery.isLoading;

  useEffect(() => {
    if (user && isStaff) {
      loadCategories();
      loadScores();
    }
  }, [user, isStaff]);

  useEffect(() => {
    if (customerId && customers.length > 0) {
      const customer = customers.find(c => c.user_id === customerId);
      if (customer) {
        setSelectedCustomer(customer);
        loadCustomerTools(customerId);
        loadCustomerOrders(customerId);
      }
    }
  }, [customerId, customers]);

  const loadCategories = async () => {
    const { data } = await supabase.from('tool_categories').select('*').order('name');
    if (data) setCategories(data);
  };

  const loadScores = async () => {
    if (!user?.id) return;
    try {
      // farmer_client_scores tem ~1 linha por cliente da carteira (milhares).
      // PostgREST capa em 1000 linhas/request, então paginamos com .range() até
      // a página vir incompleta (ou bater um teto de segurança) — sem isso, os
      // scores de clientes além dos 1000 primeiros ficavam silenciosamente vazios.
      const SCORES_PAGE_SIZE = 1000;
      const MAX_PAGES = 50; // teto de segurança = 50.000 scores
      const map = new Map<string, ClientScore>();
      for (let page = 0; page < MAX_PAGES; page++) {
        const from = page * SCORES_PAGE_SIZE;
        const to = from + SCORES_PAGE_SIZE - 1;
        const { data, error } = await supabase
          .from('farmer_client_scores')
          .select('customer_user_id, health_score, health_class, churn_risk, expansion_score, priority_score, avg_monthly_spend_180d, days_since_last_purchase, category_count, gross_margin_pct, avg_repurchase_interval')
          .eq('farmer_id', user.id)
          .range(from, to);
        if (error) throw error;
        if (!data || data.length === 0) break;
        // Database row tem fields nullable; normaliza pra non-null com defaults
        data.forEach((s) => map.set(s.customer_user_id, {
          customer_user_id: s.customer_user_id,
          health_score: s.health_score ?? 0,
          health_class: s.health_class ?? 'critico',
          churn_risk: s.churn_risk ?? 0,
          expansion_score: s.expansion_score ?? 0,
          priority_score: s.priority_score ?? 0,
          avg_monthly_spend_180d: s.avg_monthly_spend_180d ?? 0,
          days_since_last_purchase: s.days_since_last_purchase ?? 0,
          category_count: s.category_count ?? 0,
          gross_margin_pct: s.gross_margin_pct ?? 0,
        }));
        if (data.length < SCORES_PAGE_SIZE) break;
      }
      setScores(map);
    } catch (e) {
      console.error('Error loading scores:', e);
    }
  };

  const loadCustomerTools = async (userId: string) => {
    setLoadingTools(true);
    try {
      const { data } = await supabase
        .from('user_tools')
        .select('*, tool_categories (*)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      setCustomerTools((data || []) as unknown as UserTool[]);
    } catch (error) {
      console.error('Error loading customer tools:', error);
    } finally {
      setLoadingTools(false);
    }
  };

  const loadCustomerOrders = async (userId: string) => {
    setLoadingOrders(true);
    try {
      const { data } = await supabase
        .from('sales_orders')
        .select('id, total, status, created_at, items')
        .eq('customer_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      setOrders((data || []) as SalesOrder[]);
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoadingOrders(false);
    }
  };

  const handleSelectCustomer = (customer: Customer) => {
    setSelectedCustomer(customer);
    loadCustomerTools(customer.user_id);
    loadCustomerOrders(customer.user_id);
    navigate(`/admin/customers/${customer.user_id}`);
  };

  const handleDeleteTool = async (toolId: string) => {
    try {
      const { error } = await supabase.from('user_tools').delete().eq('id', toolId);
      if (error) throw error;
      toast.success('Ferramenta removida');
      setCustomerTools(prev => prev.filter(t => t.id !== toolId));
    } catch (error) {
      toast.error('Erro ao remover');
    }
  };

  const handleBack = () => {
    setSelectedCustomer(null);
    navigate('/admin/customers');
  };

  const reloadSelectedTools = () => {
    if (selectedCustomer) loadCustomerTools(selectedCustomer.user_id);
  };

  return {
    authLoading,
    isStaff,
    loading,
    customers,
    scores,
    categories,
    selectedCustomer,
    customerTools,
    orders,
    loadingTools,
    loadingOrders,
    addToolDialogOpen,
    setAddToolDialogOpen,
    hasNextPage: !!customersQuery.hasNextPage,
    isFetchingNextPage: customersQuery.isFetchingNextPage,
    fetchNextPage: () => customersQuery.fetchNextPage(),
    handleSelectCustomer,
    handleDeleteTool,
    handleBack,
    reloadSelectedTools,
  };
}
