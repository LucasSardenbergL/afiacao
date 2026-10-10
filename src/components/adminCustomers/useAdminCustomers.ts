// Hook de dados/estado do AdminCustomers (orquestrador).
// A LISTA (lente-aware: carteira/completa) vem de useClientesScope (read-only, isolado
// p/ não misturar a lente de exibição com mutação — ver guard de impersonação).
// Aqui: estado de detalhe (cliente selecionado, ferramentas, pedidos) + mutações.
// Spec: docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { useClientesScope } from './useClientesScope';
import type { Customer, ToolCategory, UserTool, SalesOrder } from './types';

export function useAdminCustomers() {
  const navigate = useNavigate();
  const { customerId } = useParams<{ customerId?: string }>();
  // `?search=` é escrito (com debounce) pela CustomerListView via useUrlState; aqui só lemos,
  // para a busca ir ao servidor no modo completa.
  const [searchParams] = useSearchParams();
  const busca = searchParams.get('search') ?? '';
  const { user, isStaff, loading: authLoading } = useAuth();

  const {
    customers, scores, total, isCarteira, loading, isError, refetch,
    hasNextPage, isFetchingNextPage, fetchNextPage, effectiveUserId,
    buscaNoServidor, buscando, clienteAlvo,
  } = useClientesScope({ busca, customerIdAlvo: customerId ?? null });

  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerTools, setCustomerTools] = useState<UserTool[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);
  // De quem já carregamos ferramentas/pedidos — evita recarregar a cada página da lista.
  const detalheCarregadoDe = useRef<string | null>(null);

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  // Reset do detalhe ao trocar de lente: A→B não pode deixar o cliente de A na tela.
  // effectiveUserId é só leitura aqui (vem do scope) — nenhuma escrita usa esse id.
  useEffect(() => {
    setSelectedCustomer(null);
    setCustomerTools([]);
    setOrders([]);
    detalheCarregadoDe.current = null;
  }, [effectiveUserId]);

  useEffect(() => {
    if (user && isStaff) loadCategories();
  }, [user, isStaff]);

  // Deep link: o scope resolve o cliente por id mesmo fora das páginas carregadas. Só carrega
  // ferramentas/pedidos quando o cliente MUDA — antes isto re-disparava a cada página da lista.
  const alvo = clienteAlvo.estado === 'encontrado' ? clienteAlvo.customer : null;
  useEffect(() => {
    if (!customerId) {
      // Voltar pelo histórico (/admin/customers/:id → /admin/customers) também fecha o detalhe.
      setSelectedCustomer(null);
      detalheCarregadoDe.current = null;
      return;
    }
    if (alvo && alvo.user_id === customerId) {
      setSelectedCustomer(alvo);
      if (detalheCarregadoDe.current !== alvo.user_id) {
        detalheCarregadoDe.current = alvo.user_id;
        loadCustomerTools(alvo.user_id);
        loadCustomerOrders(alvo.user_id);
      }
    }
  }, [customerId, alvo, effectiveUserId]);

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
        // Feed com badge de status (todo status de propósito), sem o pedido apagado.
        .is('deleted_at', null)
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
    detalheCarregadoDe.current = customer.user_id;
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
    detalheCarregadoDe.current = null;
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
    // Erro/retry da LISTA (vem do scope) — a tela distingue "falhou" de "vazia".
    isError,
    refetch,
    customers,
    scores,
    buscaNoServidor,
    buscando,
    /** Estado do deep link — a página mostra "não encontrado" em vez de cair na lista. */
    estadoDeepLink: clienteAlvo.estado,
    retryDeepLink: clienteAlvo.estado === 'erro' ? clienteAlvo.refetch : undefined,
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
