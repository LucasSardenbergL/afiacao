// Hook de dados/estado do AdminCustomers (orquestrador).
// A LISTA (lente-aware: carteira/completa) vem de useClientesScope (read-only, isolado
// p/ não misturar a lente de exibição com mutação — ver guard de impersonação).
// Aqui: estado de detalhe (cliente selecionado, ferramentas, pedidos) + mutações.
// Spec: docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { useClientesScope } from './useClientesScope';
import type { Customer, ToolCategory, UserTool, SalesOrder } from './types';

export function useAdminCustomers() {
  const navigate = useNavigate();
  const { customerId } = useParams<{ customerId?: string }>();
  const { user, isStaff, loading: authLoading } = useAuth();

  const {
    customers, scores, total, isCarteira, loading,
    hasNextPage, isFetchingNextPage, fetchNextPage, effectiveUserId,
  } = useClientesScope();

  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerTools, setCustomerTools] = useState<UserTool[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  // Reset do detalhe ao trocar de lente: A→B não pode deixar o cliente de A na tela.
  // effectiveUserId é só leitura aqui (vem do scope) — nenhuma escrita usa esse id.
  useEffect(() => {
    setSelectedCustomer(null);
    setCustomerTools([]);
    setOrders([]);
  }, [effectiveUserId]);

  useEffect(() => {
    if (user && isStaff) loadCategories();
  }, [user, isStaff]);

  useEffect(() => {
    if (customerId && customers.length > 0) {
      const customer = customers.find((c) => c.user_id === customerId);
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
      setCustomerTools((prev) => prev.filter((t) => t.id !== toolId));
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
    total,
    isCarteira,
    selectedCustomer,
    customerTools,
    orders,
    loadingTools,
    loadingOrders,
    addToolDialogOpen,
    setAddToolDialogOpen,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    handleSelectCustomer,
    handleDeleteTool,
    handleBack,
    reloadSelectedTools,
  };
}
