// Camada de dados/estado do planejador de rotas (AdminRoutePlanner).
// Extraída de src/pages/AdminRoutePlanner.tsx (god-component split — fatia final).
// Owns: state, loaders Supabase, handlers de check-in/out, geocoding progressivo,
// allStops/filteredStops/optimizedRoute, memos de stats e navegação.
// A página mantém apenas os refs/efeitos do Leaflet (acoplados ao DOM) + o JSX.
// Movimento puro, behavior-preserving — sem mudança de lógica.
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { toast } from 'sonner';
import { navLink } from '@/lib/maps/nav-link';
import type {
  StopType,
  PlanningMode,
  PlanningContext,
  FilterPeriod,
  ManualFilter,
  ManualCustomer,
  VisitStatus,
  RouteStop,
  CityOption,
} from '@/components/reposicao/routePlanner/types';
import { enrichWithPriority } from '@/components/reposicao/routePlanner/priority';
import { STOP_DURATION_MIN } from '@/components/reposicao/routePlanner/constants';
import type { Tables } from '@/integrations/supabase/types';
import { visitasAgendadasTable } from '@/integrations/supabase/visitasAgendadas';
import type { VisitaAgendadaRow } from '@/integrations/supabase/visitasAgendadas';
import { agendaToRouteStop } from '@/lib/visitas/agenda-to-stop';
import { prospectRowToStopDraft } from '@/lib/route/prospect-stop';
import type { ProspectRow } from '@/lib/route/prospect-stop';
import {
  defaultContextForRole,
  nextModeForContext,
  dedupeStopsById,
  particionarAlvos,
  aplicarFiltrosAlvos,
  bairrosDe,
  toggleTarget,
  FILTROS_ALVO_INICIAL,
  type FiltrosAlvo,
} from '@/lib/route/field-targets';
import { carteiraRowToStop, type CarteiraRow } from '@/lib/route/carteira-stop';
import { montarDetalheAlvo, type AlvoDetalhe } from '@/lib/route/alvo-detalhe';
import { ordenarFilaGeocode, ordenarFilaGeocodeCep } from '@/lib/route/geocode-fila';
import { normalizarCep } from '@/lib/route/cep';

// Teto de prospects por cidade pedido à RPC (a RPC capa em 2000 no SQL).
// Divinópolis (600) cabe inteira; metrópole mostra os 1000 mais quentes.
const PROSPECTS_POR_CIDADE = 1000;

// Linha de route_visits enriquecida com o nome do cliente (resolvido via profiles).
export type TodayVisitRow = Tables<'route_visits'> & { customerName: string };

// Endereço cru vindo de orders.address (jsonb) — campos opcionais.
type RawAddress = {
  street?: string;
  number?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  complement?: string;
};

// Projeção de user_tools + embed tool_categories(name) usada em loadCommercialStops.
type OverdueToolRow = {
  user_id: string;
  tool_categories: { name: string | null } | null;
};

export function useRoutePlanner() {
  const navigate = useNavigate();
  const { user, isStaff, isMaster, isGestorComercial, loading: authLoading } = useAuth();

  const [logisticStops, setLogisticStops] = useState<RouteStop[]>([]);
  const [commercialStops, setCommercialStops] = useState<RouteStop[]>([]);
  const [scheduledVisitStops, setScheduledVisitStops] = useState<RouteStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [geocodingPendentes, setGeocodingPendentes] = useState(0);
  const [filterPeriod, setFilterPeriod] = useState<FilterPeriod>('all');
  const [planningMode, setPlanningMode] = useState<PlanningMode>('hibrido');
  const [planningContext, setPlanningContext] = useState<PlanningContext>('equipe');
  // Quem tem acesso ao contexto "campo" (a caça): master e gestor comercial.
  const temAcessoCampo = isMaster || isGestorComercial;
  // Define o contexto inicial 1× quando o auth confirma: master entra no campo,
  // o resto na equipe. Sem isso, master cairia no Híbrido (scoring pesado).
  const contextoInicialDefinido = useRef(false);

  // Manual mode state
  const [manualCustomers, setManualCustomers] = useState<ManualCustomer[]>([]);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<string>>(new Set());
  const [manualFilter, setManualFilter] = useState<ManualFilter>('todos');
  const [manualSearch, setManualSearch] = useState('');
  const [loadingManual, setLoadingManual] = useState(false);

  // Visit tracking state
  const [visitStatuses, setVisitStatuses] = useState<Map<string, VisitStatus>>(new Map());
  const [todayVisits, setTodayVisits] = useState<TodayVisitRow[]>([]);
  // Checkout dialog state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutTarget, setCheckoutTarget] = useState<{ userId: string; name: string } | null>(null);
  const [checkoutResult, setCheckoutResult] = useState('');
  const [checkoutNotes, setCheckoutNotes] = useState('');
  const [checkoutRevenue, setCheckoutRevenue] = useState('');
  // Visit timers (seconds elapsed per active check-in)
  const [visitTimers, setVisitTimers] = useState<Map<string, number>>(new Map());

  // Contexto campo: cidades escolhidas (multi) + alvos carregados.
  const [selectedCities, setSelectedCities] = useState<CityOption[]>([]);
  const [prospectStops, setProspectStops] = useState<RouteStop[]>([]);
  const [carteiraCidadeStops, setCarteiraCidadeStops] = useState<RouteStop[]>([]);
  const [loadingProspects, setLoadingProspects] = useState(false);
  // Linha crua do prospect por stopId — preserva razão social + telefone2 que o
  // prospectRowToStopDraft colapsa. Lido sob-demanda quando o Sheet de detalhe abre
  // (ref, sem re-render). A carteira não precisa (o RouteStop já carrega tudo).
  const rawProspectById = useRef<Map<string, ProspectRow>>(new Map());

  const toggleCity = useCallback((city: CityOption) => {
    setSelectedCities((prev) =>
      prev.some((c) => c.codigo === city.codigo)
        ? prev.filter((c) => c.codigo !== city.codigo)
        : [...prev, city],
    );
  }, []);

  const removeCity = useCallback((codigo: string) => {
    setSelectedCities((prev) => prev.filter((c) => c.codigo !== codigo));
  }, []);

  // Curadoria do contexto campo: alvos marcados pra rota + filtro do universo.
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(new Set());
  const [filtros, setFiltros] = useState<FiltrosAlvo>(FILTROS_ALVO_INICIAL);

  const toggleTargetId = useCallback((id: string) => {
    setSelectedTargetIds((prev) => toggleTarget(prev, id));
  }, []);

  // Curadoria F: "remover da sessão" — Set em memória, sem tocar o banco. Some da
  // lista E do mapa (via filteredFieldTargets). Reseta ao trocar de cidade.
  const [removidos, setRemovidos] = useState<Set<string>>(new Set());

  const restaurarAlvo = useCallback((id: string) => {
    setRemovidos((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const removerAlvo = useCallback((id: string, nome?: string) => {
    setRemovidos((prev) => new Set(prev).add(id));
    // Se estava marcado pra rota, desmarca (senão seguiria na rota otimizada).
    setSelectedTargetIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    toast(`${nome?.trim() || 'Alvo'} removido da lista`, {
      action: { label: 'Desfazer', onClick: () => restaurarAlvo(id) },
    });
  }, [restaurarAlvo]);

  // Monta o view-model do Sheet de detalhe: lê a linha crua do prospect (ref) e
  // delega ao helper puro. Carteira não tem raw → o helper usa só o stop.
  const detalheDoAlvo = useCallback(
    (stop: RouteStop): AlvoDetalhe =>
      montarDetalheAlvo({ stop, prospectRow: rawProspectById.current.get(stop.id) ?? null }),
    [],
  );

  const { agenda, clientScores, loading: scoringLoading } = useFarmerScoring();

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  // Troca de contexto: ajusta o modo interno coerentemente (campo→prospeccao;
  // equipe→hibrido se vinha de prospeccao). Helper puro testado.
  const mudarContexto = useCallback((ctx: PlanningContext) => {
    setPlanningContext(ctx);
    setPlanningMode((prev) => nextModeForContext(ctx, prev));
  }, []);

  // Contexto inicial por papel, 1× quando o auth confirma. Só quem tem acesso ao
  // campo é redirecionado; o resto fica em 'equipe' (default do estado).
  useEffect(() => {
    if (!contextoInicialDefinido.current && !authLoading && temAcessoCampo) {
      const ctx = defaultContextForRole(isMaster);
      setPlanningContext(ctx);
      setPlanningMode((prev) => nextModeForContext(ctx, prev));
      contextoInicialDefinido.current = true;
    }
  }, [authLoading, temAcessoCampo, isMaster]);

  // Load logistic stops (existing orders)
  useEffect(() => {
    if (user && isStaff) loadLogisticStops();
  }, [user, isStaff]);

  // Load commercial stops once scoring data is ready
  useEffect(() => {
    if (!scoringLoading && agenda.length > 0) {
      loadCommercialStops();
    } else if (!scoringLoading) {
      // No agenda items, also load overdue tools
      loadCommercialStops();
    }
  }, [scoringLoading, agenda]);

  // Load scheduled visits for today (comercial + hibrido modes)
  useEffect(() => {
    if (user && isStaff) loadScheduledVisits();
  }, [user, isStaff]);

  // Always load today's visits (all modes)
  useEffect(() => {
    if (user && isStaff) loadTodayVisits();
  }, [user, isStaff]);

  // Load manual mode customers
  useEffect(() => {
    if (user && isStaff && planningMode === 'manual') {
      loadManualCustomers();
    }
  }, [user, isStaff, planningMode]);

  // Timer: tick every second for active check-ins
  useEffect(() => {
    if (visitStatuses.size === 0) return;
    const interval = setInterval(() => {
      setVisitTimers(() => {
        const next = new Map<string, number>();
        visitStatuses.forEach(status => {
          if (status.isCheckedIn && status.checkInAt) {
            next.set(status.stopId, Math.floor((Date.now() - new Date(status.checkInAt).getTime()) / 1000));
          }
        });
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [visitStatuses]);

  const loadLogisticStops = async () => {
    try {
      const { data: orders, error } = await supabase
        .from('orders')
        .select('*')
        .in('status', ['pedido_recebido', 'aguardando_coleta', 'pronto_entrega', 'em_rota'])
        .in('delivery_option', ['coleta_entrega', 'somente_coleta', 'somente_entrega']);

      if (error) throw error;
      if (!orders || orders.length === 0) {
        setLogisticStops([]);
        setLoading(false);
        return;
      }

      const userIds = [...new Set(orders.map(o => o.user_id))];
      const [{ data: profiles }, { data: addresses }] = await Promise.all([
        supabase.from('profiles').select('user_id, name, phone, business_hours_open, business_hours_close').in('user_id', userIds),
        supabase.from('addresses').select('*').in('user_id', userIds),
      ]);

      const stops: RouteStop[] = orders.map(order => {
        const profile = profiles?.find(p => p.user_id === order.user_id);
        const orderAddress = order.address as unknown as RawAddress | null;
        const defaultAddr = addresses?.find(a => a.user_id === order.user_id && a.is_default) || addresses?.find(a => a.user_id === order.user_id);
        const addr = orderAddress || defaultAddr;

        const isDelivery = order.status === 'pronto_entrega' || order.status === 'em_rota';

        return enrichWithPriority({
          id: order.id,
          stopType: isDelivery ? 'deliver_tools' as StopType : 'pickup_tools' as StopType,
          customerUserId: order.user_id,
          customerName: profile?.name || 'Cliente',
          phone: profile?.phone || null,
          address: addr ? {
            street: addr.street || '', number: addr.number || '', neighborhood: addr.neighborhood || '',
            city: addr.city || '', state: addr.state || '', zip_code: addr.zip_code || '',
            complement: addr.complement || undefined,
          } : { street: '', number: '', neighborhood: '', city: '', state: '', zip_code: '' },
          timeSlot: order.time_slot,
          businessHoursOpen: profile?.business_hours_open || null,
          businessHoursClose: profile?.business_hours_close || null,
          status: order.status,
          visitReason: isDelivery ? 'Entrega de ferramentas' : 'Coleta de ferramentas',
          orderId: order.id,
          total: order.total,
        });
      });

      setLogisticStops(stops);
    } catch (error) {
      console.error('Error loading logistic stops:', error);
      toast.error('Erro ao carregar pedidos');
    } finally {
      setLoading(false);
    }
  };

  const loadManualCustomers = async () => {
    setLoadingManual(true);
    try {
      // Load all approved non-employee customers
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('user_id, name, phone, customer_type')
        .or('is_employee.is.null,is_employee.eq.false')
        .order('name');

      if (profileError) throw profileError;
      if (!profiles || profiles.length === 0) {
        setManualCustomers([]);
        return;
      }

      const userIds = profiles.map(p => p.user_id);

      // Load addresses (best effort — customers may not have one yet)
      const { data: addresses } = await supabase
        .from('addresses')
        .select('*')
        .in('user_id', userIds)
        .order('is_default', { ascending: false });

      // Load last visit dates
      const { data: lastVisits } = await supabase
        .from('route_visits')
        .select('customer_user_id, check_in_at')
        .in('customer_user_id', userIds)
        .not('check_in_at', 'is', null)
        .order('check_in_at', { ascending: false });

      // Load last order dates
      const { data: lastOrders } = await supabase
        .from('sales_orders')
        .select('customer_user_id, created_at')
        .in('customer_user_id', userIds)
        .order('created_at', { ascending: false });

      // Build customer list — ALL profiles, address is optional
      const now = new Date();
      const customers: ManualCustomer[] = profiles.map(profile => {
        const addr = addresses?.find(a => a.user_id === profile.user_id);

        const lastVisit = lastVisits?.find(v => v.customer_user_id === profile.user_id);
        const lastOrder = lastOrders?.find(o => o.customer_user_id === profile.user_id);

        const lastVisitDate = lastVisit?.check_in_at || null;
        const lastOrderDate = lastOrder?.created_at || null;

        const daysSinceLastVisit = lastVisitDate
          ? Math.floor((now.getTime() - new Date(lastVisitDate).getTime()) / (1000 * 60 * 60 * 24))
          : null;

        const daysSinceLastOrder = lastOrderDate
          ? Math.floor((now.getTime() - new Date(lastOrderDate).getTime()) / (1000 * 60 * 60 * 24))
          : null;

        return {
          user_id: profile.user_id,
          name: profile.name,
          phone: profile.phone,
          city: addr?.city || '',
          neighborhood: addr?.neighborhood || '',
          hasAddress: !!addr,
          address: {
            street: addr?.street || '',
            number: addr?.number || '',
            neighborhood: addr?.neighborhood || '',
            city: addr?.city || '',
            state: addr?.state || '',
            zip_code: addr?.zip_code || '',
            complement: addr?.complement || undefined,
          },
          lastVisitDate,
          lastOrderDate,
          daysSinceLastVisit,
          daysSinceLastOrder,
        };
      });

      // Sort: never visited first, then by days since last visit
      customers.sort((a, b) => {
        if (a.daysSinceLastVisit === null && b.daysSinceLastVisit === null) return 0;
        if (a.daysSinceLastVisit === null) return -1;
        if (b.daysSinceLastVisit === null) return 1;
        return b.daysSinceLastVisit - a.daysSinceLastVisit;
      });

      setManualCustomers(customers);
    } catch (error) {
      console.error('Error loading manual customers:', error);
      toast.error('Erro ao carregar clientes');
    } finally {
      setLoadingManual(false);
    }
  };

  const loadTodayVisits = async () => {
    if (!user) return;
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('route_visits')
      .select('*')
      .eq('visited_by', user.id)
      .eq('visit_date', today)
      .order('check_in_at', { ascending: false });

    if (data && data.length > 0) {
      // Fetch customer names
      const ids = [...new Set(data.map(v => v.customer_user_id))];
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', ids);
      const nameMap = new Map((profs || []).map(p => [p.user_id, p.name]));
      const enriched: TodayVisitRow[] = data.map(v => ({ ...v, customerName: nameMap.get(v.customer_user_id) || 'Cliente' }));

      setTodayVisits(enriched);

      // Build active check-in status map
      const statusMap = new Map<string, VisitStatus>();
      enriched.forEach(visit => {
        if (visit.check_in_at && !visit.check_out_at) {
          statusMap.set(visit.customer_user_id, {
            stopId: visit.customer_user_id,
            visitId: visit.id,
            checkInAt: visit.check_in_at,
            isCheckedIn: true,
          });
        }
      });
      setVisitStatuses(statusMap);
    } else {
      setTodayVisits([]);
    }
  };

  const handleCheckIn = async (customer: ManualCustomer) => {
    if (!user) return;

    const doInsert = async (lat?: number, lng?: number) => {
      try {
        const { data, error } = await supabase
          .from('route_visits')
          .insert({
            customer_user_id: customer.user_id,
            visited_by: user.id,
            visit_type: 'comercial',
            check_in_at: new Date().toISOString(),
            ...(lat !== undefined && { lat, lng }),
          })
          .select()
          .single();

        if (error) throw error;

        setVisitStatuses(prev => new Map(prev).set(customer.user_id, {
          stopId: customer.user_id,
          visitId: data.id,
          checkInAt: data.check_in_at,
          isCheckedIn: true,
        }));

        await loadTodayVisits();
        toast.success('Check-in realizado!', { description: `Visita iniciada: ${customer.name}` });
      } catch (err) {
        console.error('Check-in error:', err);
        toast.error('Erro ao fazer check-in');
      }
    };

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => doInsert(pos.coords.latitude, pos.coords.longitude),
        () => doInsert(),
        { timeout: 5000 }
      );
    } else {
      doInsert();
    }
  };

  const handleCheckOut = async (userId: string, visitId: string, customerName: string, result: string, notes: string, revenue: number) => {
    try {
      const { error } = await supabase
        .from('route_visits')
        .update({
          check_out_at: new Date().toISOString(),
          result,
          notes,
          revenue_generated: revenue,
          order_created: result === 'pedido_fechado',
        })
        .eq('id', visitId);

      if (error) throw error;

      setVisitStatuses(prev => {
        const m = new Map(prev);
        m.delete(userId);
        return m;
      });

      setVisitTimers(prev => {
        const m = new Map(prev);
        m.delete(userId);
        return m;
      });

      setCheckoutOpen(false);
      await loadTodayVisits();
      toast.success('Check-out realizado!', { description: `Visita finalizada: ${customerName}` });

      if (result === 'pedido_fechado') {
        navigate(`/sales/new?customer=${userId}`);
      }
    } catch (err) {
      console.error('Check-out error:', err);
      toast.error('Erro ao fazer check-out');
    }
  };

  const openCheckoutDialog = (userId: string, name: string) => {
    setCheckoutTarget({ userId, name });
    setCheckoutResult('');
    setCheckoutNotes('');
    setCheckoutRevenue('');
    setCheckoutOpen(true);
  };

  const confirmCheckout = () => {
    if (!checkoutTarget || !checkoutResult) return;
    const status = visitStatuses.get(checkoutTarget.userId);
    if (!status?.visitId) return;
    handleCheckOut(checkoutTarget.userId, status.visitId, checkoutTarget.name, checkoutResult, checkoutNotes, parseFloat(checkoutRevenue) || 0);
  };

  const handleCheckInStop = async (stop: RouteStop) => {
    if (!user) return;

    const doInsert = async (lat?: number, lng?: number) => {
      try {
        const vType = stop.stopType === 'pickup_tools' ? 'coleta' : stop.stopType === 'deliver_tools' ? 'entrega' : 'comercial';
        const { data, error } = await supabase
          .from('route_visits')
          .insert({
            customer_user_id: stop.customerUserId,
            visited_by: user.id,
            visit_type: vType,
            check_in_at: new Date().toISOString(),
            ...(lat !== undefined && { lat, lng }),
          })
          .select()
          .single();

        if (error) throw error;

        setVisitStatuses(prev => new Map(prev).set(stop.customerUserId, {
          stopId: stop.customerUserId,
          visitId: data.id,
          checkInAt: data.check_in_at,
          isCheckedIn: true,
        }));

        await loadTodayVisits();
        toast.success('Check-in realizado!', { description: `Visita iniciada: ${stop.customerName}` });
      } catch (err) {
        toast.error('Erro ao fazer check-in');
      }
    };

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => doInsert(pos.coords.latitude, pos.coords.longitude),
        () => doInsert(),
        { timeout: 5000 }
      );
    } else {
      doInsert();
    }
  };

  const formatTimer = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const loadScheduledVisits = async () => {
    if (!user) {
      setScheduledVisitStops([]);
      return;
    }
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data, error } = await visitasAgendadasTable()
        .select('*')
        .eq('scheduled_by', user.id)
        .eq('status', 'pendente')
        .eq('scheduled_date', today);

      if (error) {
        console.error('Error loading scheduled visits:', error);
        setScheduledVisitStops([]);
        return;
      }

      const rows = (data as unknown as VisitaAgendadaRow[]) || [];
      if (rows.length === 0) {
        setScheduledVisitStops([]);
        return;
      }

      const customerIds = [...new Set(rows.map(r => r.customer_user_id))];

      const [{ data: profiles }, { data: addresses }] = await Promise.all([
        supabase
          .from('profiles')
          .select('user_id, name, phone, business_hours_open, business_hours_close')
          .in('user_id', customerIds),
        supabase
          .from('addresses')
          .select('*')
          .in('user_id', customerIds)
          .order('is_default', { ascending: false }),
      ]);

      const profileMap = new Map((profiles || []).map(p => [p.user_id, p]));
      // Pick first address per customer (default if available, then any)
      const addressMap = (addresses || []).reduce((map, addr) => {
        if (!map.has(addr.user_id)) map.set(addr.user_id, addr);
        return map;
      }, new Map<string, Tables<'addresses'>>());

      const stops: RouteStop[] = rows.map(row => {
        const profile = profileMap.get(row.customer_user_id);
        const addr = addressMap.get(row.customer_user_id);

        const input = agendaToRouteStop(
          row,
          profile
            ? {
                name: profile.name,
                phone: profile.phone,
                business_hours_open: profile.business_hours_open,
                business_hours_close: profile.business_hours_close,
              }
            : undefined,
          addr
            ? {
                street: addr.street,
                number: addr.number,
                neighborhood: addr.neighborhood,
                city: addr.city,
                state: addr.state,
                zip_code: addr.zip_code,
                complement: addr.complement,
              }
            : undefined,
        );

        // Visita agendada manualmente: prioridade explícita 'alta' (compromisso explícito).
        // NÃO usa enrichWithPriority porque scheduled_visit não tem scoring mapeado
        // e resultaria em score 0 / label 'baixa' — incorreto para um compromisso agendado.
        return {
          ...input,
          priorityScore: 70,
          priorityLabel: 'alta' as RouteStop['priorityLabel'],
          priorityFactors: ['Agendada manualmente'],
        };
      });

      setScheduledVisitStops(stops);
    } catch (err) {
      console.error('Error loading scheduled visits:', err);
      setScheduledVisitStops([]);
    }
  };

  const loadCommercialStops = async () => {
    try {
      // Gather customer IDs from logistic stops for hybrid detection
      const logisticCustomerIds = new Set(logisticStops.map(s => s.customerUserId));

      // --- Source A: Farmer Agenda ---
      const agendaCustomerIds = agenda.map(a => a.customer_user_id);

      // --- Source B: Overdue tools ---
      const now = new Date();
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const { data: overdueTools } = await supabase
        .from('user_tools')
        .select('id, user_id, tool_category_id, next_sharpening_due, tool_categories(name)')
        .lte('next_sharpening_due', sevenDaysFromNow.toISOString())
        .order('next_sharpening_due');

      // Group overdue tools by user
      const overdueByUser = new Map<string, string[]>();
      ((overdueTools || []) as unknown as OverdueToolRow[]).forEach((t) => {
        const toolName = t.tool_categories?.name || 'Ferramenta';
        if (!overdueByUser.has(t.user_id)) overdueByUser.set(t.user_id, []);
        overdueByUser.get(t.user_id)!.push(toolName);
      });

      const overdueCustomerIds = [...overdueByUser.keys()];

      // Combine all commercial customer IDs
      const allCommercialIds = [...new Set([...agendaCustomerIds, ...overdueCustomerIds])];
      if (allCommercialIds.length === 0) {
        setCommercialStops([]);
        return;
      }

      // Load profiles & addresses for commercial customers
      const [{ data: profiles }, { data: addresses }] = await Promise.all([
        supabase.from('profiles').select('user_id, name, phone, business_hours_open, business_hours_close').in('user_id', allCommercialIds),
        supabase.from('addresses').select('*').in('user_id', allCommercialIds).order('is_default', { ascending: false }),
      ]);

      const profileMap = new Map((profiles || []).map(p => [p.user_id, p]));
      // Pick first address per user (default if exists, otherwise any)
      const addressMap = (addresses || []).reduce((map, addr) => {
        if (!map.has(addr.user_id)) {
          map.set(addr.user_id, addr);
        }
        return map;
      }, new Map<string, Tables<'addresses'>>());

      // Deduplicate: build one stop per customer
      const seen = new Set<string>();
      const stops: RouteStop[] = [];

      for (const cid of allCommercialIds) {
        if (seen.has(cid)) continue;
        seen.add(cid);

        const profile = profileMap.get(cid);
        const addr = addressMap.get(cid);
        if (!addr) continue; // Skip customers without address

        const isInAgenda = agendaCustomerIds.includes(cid);
        const hasOverdueTools = overdueByUser.has(cid);
        const hasLogisticOrder = logisticCustomerIds.has(cid);

        // Determine stop type
        let stopType: StopType = 'sales_visit';
        if ((isInAgenda || hasOverdueTools) && hasLogisticOrder) {
          stopType = 'hybrid_visit';
        }

        // Build visit reason
        const reasons: string[] = [];
        if (isInAgenda) {
          const agendaItem = agenda.find(a => a.customer_user_id === cid);
          if (agendaItem) {
            const score = clientScores.find(s => s.customer_user_id === cid);
            if (agendaItem.agendaType === 'risco') {
              reasons.push(`Risco — ${score?.daysSinceLastPurchase || '?'} dias sem compra`);
            } else if (agendaItem.agendaType === 'expansao') {
              reasons.push('Expansão — oportunidade cross-sell');
            } else {
              reasons.push('Follow-up comercial');
            }
          }
        }
        if (hasOverdueTools) {
          const tools = overdueByUser.get(cid)!;
          reasons.push(`${tools.length} ferramenta(s) com afiação vencida`);
        }

        stops.push(enrichWithPriority({
          id: `commercial-${cid}`,
          stopType,
          customerUserId: cid,
          customerName: profile?.name || 'Cliente',
          phone: profile?.phone || null,
          address: {
            street: addr.street, number: addr.number, neighborhood: addr.neighborhood,
            city: addr.city, state: addr.state, zip_code: addr.zip_code,
            complement: addr.complement || undefined,
          },
          timeSlot: null,
          businessHoursOpen: profile?.business_hours_open || null,
          businessHoursClose: profile?.business_hours_close || null,
          status: stopType === 'hybrid_visit' ? 'hybrid' : 'commercial',
          visitReason: reasons.join(' · ') || 'Visita comercial',
        }));
      }

      setCommercialStops(stops);
    } catch (error) {
      console.error('Error loading commercial stops:', error);
    }
  };

  // Prospects de N cidades: N chamadas à RPC single (top-50 por cidade),
  // juntadas e deduplicadas no client. 2-4 cidades = 2-4 round-trips (OK).
  const loadProspectStops = useCallback(async (cities: CityOption[]) => {
    if (cities.length === 0) { setProspectStops([]); return; }
    setLoadingProspects(true);
    rawProspectById.current.clear();
    try {
      const results = await Promise.all(
        cities.map((city) =>
          supabase.rpc(
            'radar_prospects_para_rota' as never,
            { p_municipio_codigo: city.codigo, p_limit: PROSPECTS_POR_CIDADE } as never,
          ),
        ),
      );
      const rows: ProspectRow[] = [];
      for (const { data, error } of results) {
        if (error) throw error;
        rows.push(...((data ?? []) as unknown as ProspectRow[]));
      }
      const stops: RouteStop[] = rows.map((row) => {
        const draft = prospectRowToStopDraft(row);
        rawProspectById.current.set(draft.id, row);
        // Pre-cache coordinates for already-geocoded prospects
        if (draft.lat != null && draft.lng != null && draft.geocodeFailed !== true) {
          geocodedCoords.current.set(draft.id, { lat: draft.lat, lng: draft.lng });
        }
        const base: Omit<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'> = {
          id: draft.id,
          customerUserId: '',  // intentional — blocks check-in (route_visits FK)
          customerName: draft.customerName,
          phone: draft.phone ?? null,
          address: draft.address,
          visitReason: draft.visitReason,
          stopType: 'prospect_visit',
          timeSlot: null,
          businessHoursOpen: null,
          businessHoursClose: null,
          status: 'prospect',
          lat: draft.lat ?? undefined,
          lng: draft.lng ?? undefined,
          radarCnpj: draft.radarCnpj,
          geocodeFailed: draft.geocodeFailed,
          prospeccaoStatus: draft.prospeccaoStatus,
          precisao: draft.precisao,
        };
        return enrichWithPriority(base);
      });
      setProspectStops(dedupeStopsById(stops));
    } catch (err) {
      console.error('Error loading prospect stops:', err);
      toast.error('Erro ao carregar prospects');
      setProspectStops([]);
    } finally {
      setLoadingProspects(false);
    }
  }, []);

  // Clientes da CARTEIRA nas cidades escolhidas via RPC carteira_por_municipio
  // (SECURITY DEFINER, gate gestor/master). Casa por nome RFB normalizado + UF no
  // servidor (corrige o "zero clientes" do ilike sensível a acento/sufixo "(UF)") e
  // já traz a recência (dias_desde_visita). Entram no mapa como sales_visit.
  const loadCarteiraDaCidade = useCallback(async (cities: CityOption[]) => {
    if (cities.length === 0) { setCarteiraCidadeStops([]); return; }
    try {
      const perCity = await Promise.all(
        cities.map(async (city) => {
          const { data, error } = await supabase.rpc('carteira_por_municipio', {
            p_municipio_codigo: city.codigo,
          });
          if (error) throw error;
          return { cityNome: city.nome, rows: (data ?? []) as unknown as CarteiraRow[] };
        }),
      );
      // Dedup por user_id (a primeira cidade que trouxe vence).
      const seen = new Set<string>();
      const stops: RouteStop[] = [];
      for (const { cityNome, rows } of perCity) {
        for (const row of rows) {
          if (!row.user_id || seen.has(row.user_id)) continue;
          seen.add(row.user_id);
          const draft = carteiraRowToStop(row, cityNome);
          const base: Omit<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'> = {
            id: draft.id,
            customerUserId: draft.customerUserId,
            customerName: draft.customerName,
            phone: draft.phone,
            address: draft.address,
            visitReason: draft.visitReason,
            stopType: 'sales_visit',
            timeSlot: null,
            businessHoursOpen: draft.businessHoursOpen,
            businessHoursClose: draft.businessHoursClose,
            status: 'carteira',
            diasDesdeVisita: draft.diasDesdeVisita,
            lat: draft.lat,
            lng: draft.lng,
            precisao: draft.precisao,
          };
          stops.push(enrichWithPriority(base));
        }
      }
      setCarteiraCidadeStops(dedupeStopsById(stops));
    } catch (err) {
      console.error('Error loading carteira da cidade:', err);
      setCarteiraCidadeStops([]);
    }
  }, []);

  // Load prospects + carteira when in prospeccao mode and a city is selected
  // NOTE: must live AFTER load* declarations (const is not hoisted)
  useEffect(() => {
    if (planningMode === 'prospeccao' && selectedCities.length > 0) {
      void loadProspectStops(selectedCities);
      void loadCarteiraDaCidade(selectedCities);
    } else {
      setProspectStops([]);
      setCarteiraCidadeStops([]);
    }
  }, [planningMode, selectedCities, loadProspectStops, loadCarteiraDaCidade]);

  // Trocar as cidades reinicia a curadoria e os filtros (universo novo).
  useEffect(() => {
    setSelectedTargetIds(new Set());
    setFiltros(FILTROS_ALVO_INICIAL);
    setRemovidos(new Set());
    geocodeFalhados.current.clear(); // nova cidade → permite re-tentar geocodes que falharam
    cepFalhados.current.clear();
    geocodedCepCoords.current.clear();
  }, [selectedCities]);

  // Merge stops based on planning mode
  const allStops = useMemo(() => {
    // Also upgrade logistic stops to hybrid if they overlap with commercial
    const commercialCustomerIds = new Set(commercialStops.map(s => s.customerUserId));

    const upgraded = logisticStops.map(s => {
      if (commercialCustomerIds.has(s.customerUserId)) {
        const commercial = commercialStops.find(c => c.customerUserId === s.customerUserId);
        const merged = {
          ...s,
          stopType: 'hybrid_visit' as StopType,
          visitReason: `${s.visitReason} · ${commercial?.visitReason || ''}`,
        };
        return enrichWithPriority(merged);
      }
      return s;
    });

    // Remove commercial stops that have been merged into logistic
    const mergedLogisticCustomerIds = new Set(upgraded.filter(s => s.stopType === 'hybrid_visit').map(s => s.customerUserId));
    const uniqueCommercial = commercialStops.filter(s => !mergedLogisticCustomerIds.has(s.customerUserId));

    // Dedup scheduled visits against customers already present in logistic or commercial
    const existingCustomerIds = new Set([
      ...upgraded.map(s => s.customerUserId),
      ...uniqueCommercial.map(s => s.customerUserId),
    ]);
    const uniqueScheduled = scheduledVisitStops.filter(
      s => !existingCustomerIds.has(s.customerUserId),
    );

    switch (planningMode) {
      case 'logistica': return upgraded.filter(s => s.stopType === 'pickup_tools' || s.stopType === 'deliver_tools');
      case 'comercial': return [...uniqueCommercial, ...upgraded.filter(s => s.stopType === 'hybrid_visit'), ...uniqueScheduled];
      case 'hibrido': return [...upgraded, ...uniqueCommercial, ...uniqueScheduled];
      case 'manual': {
        // Build manual stops from selected customers
        const manualStops: RouteStop[] = Array.from(selectedCustomerIds).map(userId => {
          const customer = manualCustomers.find(c => c.user_id === userId);
          if (!customer) return null;

          return enrichWithPriority({
            id: `manual-${userId}`,
            stopType: 'manual_visit' as StopType,
            customerUserId: userId,
            customerName: customer.name,
            phone: customer.phone,
            address: customer.address,
            timeSlot: null,
            businessHoursOpen: null,
            businessHoursClose: null,
            status: 'manual',
            visitReason: 'Visita manual',
          });
        }).filter(Boolean) as RouteStop[];

        return manualStops;
      }
      case 'prospeccao': return [...prospectStops, ...carteiraCidadeStops];
    }
  }, [logisticStops, commercialStops, scheduledVisitStops, planningMode, selectedCustomerIds, manualCustomers, prospectStops, carteiraCidadeStops]);

  // Geocode stops progressively (max 15, 1.1s delay between calls)
  const geocodedCoords = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const geocodingAbort = useRef<AbortController | null>(null);
  const geocodeFalhados = useRef<Set<string>>(new Set());
  // Geocoding por CEP (campo): coord por CEP distinto + CEPs que falharam na sessão.
  const geocodedCepCoords = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const cepFalhados = useRef<Set<string>>(new Set());
  // Modo atual num ref p/ o worker escolher a estratégia (CEP vs endereço) sem stale.
  const planningModeRef = useRef(planningMode);
  planningModeRef.current = planningMode;
  // Espelha a seleção num ref p/ o worker priorizar marcados sem re-disparar a fila.
  const selectedIdsRef = useRef<Set<string>>(new Set());
  selectedIdsRef.current = selectedTargetIds;

  const [geocodedAllStops, setGeocodedAllStops] = useState<RouteStop[]>([]);

  // Mostra os stops já com a coord da RPC; reaplica os upgrades por CEP feitos
  // nesta sessão (o CEP vence — é o refino postcode sobre o centróide do município).
  useEffect(() => {
    const enriched = allStops.map(s => {
      const cepCoord = geocodedCepCoords.current.get(normalizarCep(s.address.zip_code) ?? '');
      if (cepCoord) return { ...s, lat: cepCoord.lat, lng: cepCoord.lng, precisao: 'postcode_centroid' };
      const cached = geocodedCoords.current.get(s.id);
      return cached ? { ...s, lat: cached.lat, lng: cached.lng } : s;
    });
    setGeocodedAllStops(enriched);
  }, [allStops]);

  // Geocoding progressivo ~1/s, marcados-na-rota primeiro. CAMPO (prospeccao):
  // geocodifica o CEP DISTINTO → cep_geo_upsert → pinta TODOS os alvos do CEP de uma
  // vez (1234 empresas ≈ 574 CEPs). EQUIPE: legado por endereço/stop. Re-deriva a
  // fila a cada ciclo → marcar um alvo re-prioriza o próximo pick; resolvidos/
  // falhados saem da fila → o loop termina.
  useEffect(() => {
    geocodingAbort.current?.abort();
    const controller = new AbortController();
    geocodingAbort.current = controller;

    const nominatim = async (query: string) => {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
        { signal: controller.signal },
      );
      const data = await res.json();
      return data?.[0] ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
    };

    (async () => {
      while (!controller.signal.aborted) {
        if (planningModeRef.current === 'prospeccao') {
          // ---- Campo: por CEP distinto, persiste no cep_geo (SoT) ----
          const fila = ordenarFilaGeocodeCep(allStops, {
            resolvidos: new Set(geocodedCepCoords.current.keys()),
            falhados: cepFalhados.current,
            marcados: selectedIdsRef.current,
          });
          setGeocodingPendentes(fila.length);
          if (fila.length === 0) break;
          const { cep, cidade, uf } = fila[0];
          try {
            const coords = await nominatim(`${cep}, ${cidade}, ${uf}, Brazil`);
            if (coords) {
              geocodedCepCoords.current.set(cep, coords);
              setGeocodedAllStops(prev => prev.map(s =>
                normalizarCep(s.address.zip_code) === cep
                  ? { ...s, lat: coords.lat, lng: coords.lng, precisao: 'postcode_centroid' }
                  : s,
              ));
              // Persiste: postcode_centroid; anti-downgrade no SQL. Gate = gestor/master
              // (o contexto campo já exige). Compartilhado por todos os alvos do CEP.
              void supabase.rpc('cep_geo_upsert' as never, {
                p_cep: cep, p_lat: coords.lat, p_lng: coords.lng,
                p_source: 'nominatim', p_precision: 'postcode_centroid',
              } as never);
            } else {
              cepFalhados.current.add(cep); // sem resultado → não recicla o mesmo CEP
            }
          } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') break;
            cepFalhados.current.add(cep);
          }
        } else {
          // ---- Equipe: legado por endereço, por stop (inalterado) ----
          const fila = ordenarFilaGeocode(allStops, {
            resolvidos: new Set(geocodedCoords.current.keys()),
            falhados: geocodeFalhados.current,
            marcados: selectedIdsRef.current,
          });
          setGeocodingPendentes(fila.length);
          if (fila.length === 0) break;
          const stop = fila[0];
          try {
            const coords = await nominatim(
              `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}, Brazil`,
            );
            if (coords) {
              geocodedCoords.current.set(stop.id, coords);
              setGeocodedAllStops(prev => prev.map(s =>
                s.id === stop.id ? { ...s, lat: coords.lat, lng: coords.lng } : s,
              ));
            } else {
              geocodeFalhados.current.add(stop.id);
            }
          } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') break;
            geocodeFalhados.current.add(stop.id);
          }
        }
        // Nominatim rate limit: máx 1 req/s
        if (!controller.signal.aborted) await new Promise(r => setTimeout(r, 1100));
      }
      if (!controller.signal.aborted) setGeocodingPendentes(0);
    })();

    return () => controller.abort();
  }, [allStops]);

  // Filter by period
  const filteredStops = useMemo(() => {
    if (filterPeriod === 'all') return geocodedAllStops;
    return geocodedAllStops.filter(s => s.timeSlot === filterPeriod || !s.timeSlot);
  }, [geocodedAllStops, filterPeriod]);

  // ----- Contexto campo: universo de alvos vs rota curada -----
  // O universo é tudo que veio das cidades (prospects + carteira), já geocodificado
  // progressivamente. A rota contém SÓ os alvos marcados.
  const fieldTargets = useMemo(
    () => (planningContext === 'campo' ? geocodedAllStops : []),
    [planningContext, geocodedAllStops],
  );

  // Universo "vivo" = alvos que não foram removidos da sessão (curadoria F). Tudo
  // (lista, mapa, contagens, bairros) parte daqui pra ficar coerente com a curadoria.
  const fieldTargetsVivos = useMemo(
    () => fieldTargets.filter((s) => !removidos.has(s.id)),
    [fieldTargets, removidos],
  );

  const filteredFieldTargets = useMemo(
    () => aplicarFiltrosAlvos(fieldTargetsVivos, filtros),
    [fieldTargetsVivos, filtros],
  );

  // Bairros presentes no universo vivo (pro Select de filtro).
  const bairrosDisponiveis = useMemo(() => bairrosDe(fieldTargetsVivos), [fieldTargetsVivos]);

  // Prospects disponíveis no Radar nas cidades (soma do total já cacheado) — base
  // do aviso "1.000 de N" quando o teto trunca a carga.
  const prospectsDisponiveis = useMemo(
    () => selectedCities.reduce((acc, c) => acc + (c.total ?? 0), 0),
    [selectedCities],
  );

  const resumoAlvos = useMemo(() => {
    const { clientes, prospects } = particionarAlvos(fieldTargetsVivos);
    return { totalClientes: clientes.length, totalProspects: prospects.length };
  }, [fieldTargetsVivos]);

  // Paradas que entram na otimização: no campo, só os marcados; na equipe, como hoje.
  const stopsParaRota = useMemo(() => {
    if (planningContext === 'campo') {
      return geocodedAllStops.filter((s) => selectedTargetIds.has(s.id));
    }
    return filteredStops;
  }, [planningContext, geocodedAllStops, selectedTargetIds, filteredStops]);

  // Optimize route: priority-grouped nearest-neighbor
  const optimizedRoute = useMemo(() => {
    if (stopsParaRota.length <= 1) return stopsParaRota;

    const withCoords = stopsParaRota.filter(s => s.lat && s.lng);
    const withoutCoords = stopsParaRota.filter(s => !s.lat || !s.lng)
      .sort((a, b) => b.priorityScore - a.priorityScore);

    // Nearest-neighbor within a group, optionally starting from a given point
    const nearestNeighbor = (group: RouteStop[], startFrom?: RouteStop): RouteStop[] => {
      if (group.length <= 1) return group;
      const result: RouteStop[] = [];
      const remaining = [...group];

      // Pick starting point: provided anchor or highest-priority stop
      if (startFrom?.lat && startFrom?.lng) {
        // Find nearest to anchor
        let bestIdx = 0, bestDist = Infinity;
        remaining.forEach((s, i) => {
          const d = distKm(startFrom, s);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        });
        result.push(remaining.splice(bestIdx, 1)[0]);
      } else {
        remaining.sort((a, b) => b.priorityScore - a.priorityScore);
        result.push(remaining.splice(0, 1)[0]);
      }

      while (remaining.length > 0) {
        const last = result[result.length - 1];
        let bestIdx = 0, bestDist = Infinity;
        remaining.forEach((s, i) => {
          const d = distKm(last, s);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        });
        result.push(remaining.splice(bestIdx, 1)[0]);
      }
      return result;
    };

    const distKm = (a: RouteStop, b: RouteStop) => Math.sqrt(
      Math.pow((b.lat! - a.lat!) * 111, 2) +
      Math.pow((b.lng! - a.lng!) * 111 * Math.cos(a.lat! * Math.PI / 180), 2)
    );

    // Group by priority tier, then nearest-neighbor each, chaining end→start
    const buildPriorityRoute = (stops: RouteStop[]): RouteStop[] => {
      const alta = stops.filter(s => s.priorityLabel === 'alta');
      const media = stops.filter(s => s.priorityLabel === 'media');
      const baixa = stops.filter(s => s.priorityLabel === 'baixa');

      const routeAlta = nearestNeighbor(alta);
      const lastAlta = routeAlta[routeAlta.length - 1];
      const routeMedia = nearestNeighbor(media, lastAlta);
      const lastMedia = routeMedia[routeMedia.length - 1] || lastAlta;
      const routeBaixa = nearestNeighbor(baixa, lastMedia);

      return [...routeAlta, ...routeMedia, ...routeBaixa];
    };

    const morning = withCoords.filter(s => s.timeSlot === 'manha' || !s.timeSlot);
    const afternoon = withCoords.filter(s => s.timeSlot === 'tarde');

    const optimized = filterPeriod === 'tarde' ? buildPriorityRoute(afternoon)
      : filterPeriod === 'manha' ? buildPriorityRoute(morning)
      : [...buildPriorityRoute(morning), ...buildPriorityRoute(afternoon)];

    return [...optimized, ...withoutCoords];
  }, [stopsParaRota, filterPeriod]);

  const openInWaze = (stop: RouteStop) => {
    const q = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}`;
    const href = navLink(q, stop.lat ?? null, stop.lng ?? null);
    if (href) window.open(href, '_blank');
  };

  const openInGoogleMaps = (stop: RouteStop) => {
    if (stop.lat && stop.lng) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`, '_blank');
    } else {
      const q = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}`;
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`, '_blank');
    }
  };

  const filteredManualCustomers = useMemo(() => {
    let filtered = manualCustomers;

    // Apply filter
    if (manualFilter === 'nunca_visitados') {
      filtered = filtered.filter(c => c.daysSinceLastVisit === null);
    } else if (manualFilter === 'sem_compra_30d') {
      filtered = filtered.filter(c => c.daysSinceLastOrder === null || c.daysSinceLastOrder > 30);
    }

    // Apply search
    if (manualSearch.trim()) {
      const search = manualSearch.toLowerCase();
      filtered = filtered.filter(c =>
        c.name.toLowerCase().includes(search) ||
        c.city.toLowerCase().includes(search) ||
        c.neighborhood.toLowerCase().includes(search)
      );
    }

    return filtered;
  }, [manualCustomers, manualFilter, manualSearch]);

  const toggleCustomerSelection = (userId: string) => {
    setSelectedCustomerIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(userId)) {
        newSet.delete(userId);
      } else {
        newSet.add(userId);
      }
      return newSet;
    });
  };

  const estimatedManualHours = useMemo(() => {
    const count = selectedCustomerIds.size;
    const minutes = count * 20; // 20min per visit
    return (minutes / 60).toFixed(1);
  }, [selectedCustomerIds]);

  const handleStopCTA = (stop: RouteStop) => {
    if (stop.orderId) {
      navigate(`/admin/orders/${stop.orderId}`);
    } else {
      navigate(`/sales/new?customer=${stop.customerUserId}`);
    }
  };

  // Stats
  const stopCounts = useMemo(() => {
    const counts: Record<string, number> = { pickup_tools: 0, deliver_tools: 0, sales_visit: 0, hybrid_visit: 0, scheduled_visit: 0, manual_visit: 0, prospect_visit: 0 };
    optimizedRoute.forEach(s => counts[s.stopType]++);
    return counts;
  }, [optimizedRoute]);

  // Total estimated duration
  const totalEstimatedMin = useMemo(() => {
    // Sum stop durations
    const stopMin = optimizedRoute.reduce((sum, s) => sum + STOP_DURATION_MIN[s.stopType], 0);
    // Estimate travel time: ~5 min between consecutive geocoded stops (rough urban avg)
    const stopsWithCoords = optimizedRoute.filter(s => s.lat && s.lng);
    let travelMin = 0;
    for (let i = 1; i < stopsWithCoords.length; i++) {
      const a = stopsWithCoords[i - 1];
      const b = stopsWithCoords[i];
      const distKm = Math.sqrt(
        Math.pow((b.lat! - a.lat!) * 111, 2) +
        Math.pow((b.lng! - a.lng!) * 111 * Math.cos(a.lat! * Math.PI / 180), 2)
      );
      // ~30 km/h urban avg → distKm / 30 * 60 min
      travelMin += Math.round((distKm / 30) * 60);
    }
    return { stopMin, travelMin, totalMin: stopMin + travelMin };
  }, [optimizedRoute]);

  return {
    // auth / loading
    authLoading,
    isStaff,
    loading,
    geocodingPendentes,
    scoringLoading,
    // mode + period
    planningMode,
    setPlanningMode,
    filterPeriod,
    setFilterPeriod,
    // route data
    optimizedRoute,
    stopCounts,
    totalEstimatedMin,
    todayVisits,
    // manual mode
    manualFilter,
    setManualFilter,
    manualSearch,
    setManualSearch,
    loadingManual,
    filteredManualCustomers,
    selectedCustomerIds,
    estimatedManualHours,
    // visit tracking
    visitStatuses,
    visitTimers,
    formatTimer,
    // checkout dialog
    checkoutOpen,
    setCheckoutOpen,
    checkoutTarget,
    checkoutResult,
    setCheckoutResult,
    checkoutNotes,
    setCheckoutNotes,
    checkoutRevenue,
    setCheckoutRevenue,
    // contexto campo/equipe
    planningContext,
    setPlanningContext: mudarContexto,
    temAcessoCampo,
    selectedCities,
    toggleCity,
    removeCity,
    loadingProspects,
    // curadoria de alvos (contexto campo)
    fieldTargets,
    filteredFieldTargets,
    resumoAlvos,
    prospectsDisponiveis,
    bairrosDisponiveis,
    selectedTargetIds,
    toggleTargetId,
    filtros,
    setFiltros,
    removerAlvo,
    detalheDoAlvo,
    // handlers
    toggleCustomerSelection,
    handleCheckIn,
    handleCheckInStop,
    openCheckoutDialog,
    confirmCheckout,
    handleStopCTA,
    openInWaze,
    openInGoogleMaps,
  };
}
