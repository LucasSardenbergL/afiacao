// Hook de dados/estado do AdminCustomers (orquestrador).
// A LISTA (lente-aware: carteira/completa) vem de useClientesScope (read-only, isolado
// p/ não misturar a lente de exibição com mutação — ver guard de impersonação).
// Aqui: estado de detalhe (cliente selecionado, ferramentas, pedidos) + mutações.
// Spec: docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md
import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { useClientesScope } from './useClientesScope';
import {
  lerOrigemLista, montarOrigemLista, urlCliente360, urlListaClientes,
} from './navegacao';
import type { Customer, ToolCategory, UserTool, SalesOrder } from './types';

export function useAdminCustomers() {
  const navigate = useNavigate();
  const location = useLocation();
  const { customerId } = useParams<{ customerId?: string }>();
  // `?search=` é escrito (com debounce) pela CustomerListView via useUrlState; aqui só lemos,
  // para a busca ir ao servidor no modo completa.
  const [searchParams] = useSearchParams();
  const busca = searchParams.get('search') ?? '';
  // `?health=` e `?ordem=` idem: no modo completa o filtro e a ordem vão ao servidor, antes de paginar.
  const saude = searchParams.get('health');
  const ordem = searchParams.get('ordem');
  const { user, isStaff, loading: authLoading } = useAuth();

  const {
    customers, scores, total, contagemPendente, isCarteira, loading, isError, refetch,
    hasNextPage, isFetchingNextPage, fetchNextPage, effectiveUserId,
    buscaNoServidor, buscando, clienteAlvo, filtroNoServidor, totalRecorte, scoresEstado, refetchScores,
  } = useClientesScope({ busca, saude, ordem, customerIdAlvo: customerId ?? null });

  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerTools, setCustomerTools] = useState<UserTool[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  // Falha da leitura dos pedidos ≠ "nenhum pedido registrado" (ausente ≠ vazio).
  const [ordersErro, setOrdersErro] = useState(false);
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
        // `tool_category_id` é NOT NULL → `!inner` dá a categoria sem `| null` (mesmo conjunto).
        .select('*, tool_categories!inner(*)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      setCustomerTools(data ?? []);
    } catch (error) {
      console.error('Error loading customer tools:', error);
    } finally {
      setLoadingTools(false);
    }
  };

  const loadCustomerOrders = async (userId: string) => {
    setLoadingOrders(true);
    setOrdersErro(false);
    try {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, total, status, created_at, items')
        .eq('customer_user_id', userId)
        // Feed com badge de status (todo status de propósito), sem o pedido apagado.
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      // data null SEM error = resposta malformada, não "nenhum pedido".
      if (data == null) throw new Error('sales_orders: data null sem error');
      setOrders(data as SalesOrder[]);
    } catch (error) {
      console.error('Error loading orders:', error);
      setOrders([]);
      setOrdersErro(true);
    } finally {
      setLoadingOrders(false);
    }
  };

  // A lista abre a 360 — o MESMO destino da carteira, positivação, busca global e follow-ups (onda 2).
  // A ficha de cadastro segue existindo como "Cadastro e ferramentas", aberta de dentro da 360.
  const handleSelectCustomer = (customer: Customer) => {
    // A 360 leva a FILA de origem (busca/saúde/ordem + rolagem no state). A entrada da lista no
    // histórico também ganha a rolagem, para o voltar do NAVEGADOR cair na mesma posição.
    const origem = montarOrigemLista(location.search, window.scrollY);
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: { rolagem: origem.rolagem } });
    navigate(urlCliente360(customer.user_id), { state: { origemLista: origem } });
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
    // Volta para a fila de onde veio; sem origem (deep link), a fila que a URL da ficha carrega.
    const origem = lerOrigemLista(location.state);
    navigate(urlListaClientes(origem?.query ?? location.search), { state: { rolagem: origem?.rolagem ?? null } });
  };

  const retryOrders = () => {
    if (selectedCustomer) loadCustomerOrders(selectedCustomer.user_id);
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
    filtroNoServidor,
    totalRecorte,
    scoresEstado,
    refetchScores,
    /** Origem da ficha (fila da lista) — repassada ao abrir a 360 a partir dela. */
    origemLista: lerOrigemLista(location.state),
    /** Estado do deep link — a página mostra "não encontrado" em vez de cair na lista. */
    estadoDeepLink: clienteAlvo.estado,
    retryDeepLink: clienteAlvo.estado === 'erro' ? clienteAlvo.refetch : undefined,
    categories,
    total,
    contagemPendente,
    isCarteira,
    selectedCustomer,
    customerTools,
    orders,
    loadingTools,
    loadingOrders,
    ordersErro,
    retryOrders,
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
