import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { useToast } from '@/hooks/use-toast';
import { Loader2, MapPin, Clock, Route, Filter, Navigation, ExternalLink, Truck, ShoppingBag, Wrench, Layers, Phone, ArrowUp, ArrowRight, ArrowDown, Search, CheckCircle2, XCircle, Users } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default marker icons for Leaflet + bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

type StopType = 'pickup_tools' | 'deliver_tools' | 'sales_visit' | 'hybrid_visit' | 'manual_visit';
type PlanningMode = 'logistica' | 'comercial' | 'hibrido' | 'manual';
type FilterPeriod = 'all' | 'manha' | 'tarde';
type ManualFilter = 'todos' | 'nunca_visitados' | 'sem_compra_30d';

interface ManualCustomer {
  user_id: string;
  name: string;
  phone: string | null;
  city: string;
  neighborhood: string;
  address: {
    street: string;
    number: string;
    neighborhood: string;
    city: string;
    state: string;
    zip_code: string;
    complement?: string;
  };
  lastVisitDate: string | null;
  lastOrderDate: string | null;
  daysSinceLastVisit: number | null;
  daysSinceLastOrder: number | null;
}

interface VisitStatus {
  stopId: string;
  visitId: string | null;
  checkInAt: string | null;
  isCheckedIn: boolean;
}

interface RouteStop {
  id: string;
  stopType: StopType;
  customerUserId: string;
  customerName: string;
  phone: string | null;
  address: {
    street: string;
    number: string;
    neighborhood: string;
    city: string;
    state: string;
    zip_code: string;
    complement?: string;
  };
  timeSlot: string | null;
  businessHoursOpen: string | null;
  businessHoursClose: string | null;
  status: string;
  visitReason: string;
  orderId?: string;
  lat?: number;
  lng?: number;
  total?: number;
  priorityScore: number;
  priorityLabel: 'alta' | 'media' | 'baixa';
  priorityFactors: string[];
}

// ─── Priority scoring ────────────────────────────────────────────────
function computeStopPriority(stop: Omit<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'>): Pick<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'> {
  let score = 0;
  const factors: string[] = [];

  // Logistic urgency
  if (stop.stopType === 'pickup_tools') {
    score += 40; factors.push('+40 coleta pendente');
  } else if (stop.stopType === 'deliver_tools') {
    score += 35; factors.push('+35 entrega pronta');
  }

  // Overdue tools
  if (stop.visitReason.includes('afiação vencida')) {
    score += 25; factors.push('+25 ferramenta vencida');
  }

  // Commercial opportunity from agenda
  if (stop.visitReason.includes('Risco')) {
    score += 20; factors.push('+20 risco de churn');
  } else if (stop.visitReason.includes('Expansão')) {
    score += 15; factors.push('+15 expansão cross-sell');
  } else if (stop.visitReason.includes('Follow-up')) {
    score += 10; factors.push('+10 follow-up');
  }

  // Hybrid gets a bonus (multiple reasons to visit)
  if (stop.stopType === 'hybrid_visit') {
    score += 15; factors.push('+15 visita híbrida');
  }

  // Higher-value orders
  if (stop.total && stop.total > 200) {
    score += 10; factors.push('+10 pedido alto valor');
  }

  const label: RouteStop['priorityLabel'] = score > 50 ? 'alta' : score >= 25 ? 'media' : 'baixa';
  return { priorityScore: score, priorityLabel: label, priorityFactors: factors };
}

function enrichWithPriority(stop: Omit<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'>): RouteStop {
  return { ...stop, ...computeStopPriority(stop) } as RouteStop;
}

const STOP_DURATION_MIN: Record<StopType, number> = {
  pickup_tools: 10,
  deliver_tools: 8,
  sales_visit: 20,
  hybrid_visit: 30,
  manual_visit: 15,
};

const PRIORITY_CONFIG: Record<RouteStop['priorityLabel'], { label: string; bgClass: string; icon: typeof ArrowUp }> = {
  alta: { label: 'Alta', bgClass: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300', icon: ArrowUp },
  media: { label: 'Média', bgClass: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300', icon: ArrowRight },
  baixa: { label: 'Baixa', bgClass: 'bg-muted text-muted-foreground', icon: ArrowDown },
};

const STOP_CONFIG: Record<StopType, { label: string; color: string; bgClass: string; textClass: string; markerColor: string }> = {
  pickup_tools: { label: 'Coleta', color: 'hsl(210, 80%, 50%)', bgClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200', textClass: 'text-blue-600', markerColor: '#3b82f6' },
  deliver_tools: { label: 'Entrega', color: 'hsl(142, 70%, 40%)', bgClass: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200', textClass: 'text-green-600', markerColor: '#22c55e' },
  sales_visit: { label: 'Comercial', color: 'hsl(30, 90%, 50%)', bgClass: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200', textClass: 'text-orange-600', markerColor: '#f97316' },
  hybrid_visit: { label: 'Híbrido', color: 'hsl(270, 70%, 55%)', bgClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200', textClass: 'text-purple-600', markerColor: '#a855f7' },
  manual_visit: { label: 'Manual', color: 'hsl(180, 70%, 45%)', bgClass: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200', textClass: 'text-cyan-600', markerColor: '#06b6d4' },
};

const AdminRoutePlanner = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);

  const [logisticStops, setLogisticStops] = useState<RouteStop[]>([]);
  const [commercialStops, setCommercialStops] = useState<RouteStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [geocoding, setGeocoding] = useState(false);
  const [filterPeriod, setFilterPeriod] = useState<FilterPeriod>('all');
  const [planningMode, setPlanningMode] = useState<PlanningMode>('hibrido');
  
  // Manual mode state
  const [manualCustomers, setManualCustomers] = useState<ManualCustomer[]>([]);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<string>>(new Set());
  const [manualFilter, setManualFilter] = useState<ManualFilter>('todos');
  const [manualSearch, setManualSearch] = useState('');
  const [loadingManual, setLoadingManual] = useState(false);
  
  // Visit tracking state
  const [visitStatuses, setVisitStatuses] = useState<Map<string, VisitStatus>>(new Map());
  const [todayVisits, setTodayVisits] = useState<any[]>([]);
  // Checkout dialog state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutTarget, setCheckoutTarget] = useState<{ userId: string; name: string } | null>(null);
  const [checkoutResult, setCheckoutResult] = useState('');
  const [checkoutNotes, setCheckoutNotes] = useState('');
  const [checkoutRevenue, setCheckoutRevenue] = useState('');
  // Visit timers (seconds elapsed per active check-in)
  const [visitTimers, setVisitTimers] = useState<Map<string, number>>(new Map());

  const { agenda, clientScores, loading: scoringLoading } = useFarmerScoring();

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

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
        const orderAddress = order.address as any;
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
      toast({ title: 'Erro ao carregar pedidos', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const loadManualCustomers = async () => {
    setLoadingManual(true);
    try {
      // Load all customers
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('user_id, name, phone, customer_type')
        .eq('is_approved', true)
        .order('name');
      
      if (profileError) throw profileError;
      console.log('[Manual] Profiles aprovados encontrados:', profiles?.length || 0);
      if (!profiles || profiles.length === 0) {
        setManualCustomers([]);
        return;
      }
      
      const userIds = profiles.map(p => p.user_id);
      
      // Load default addresses
      const { data: addresses } = await supabase
        .from('addresses')
        .select('*')
        .in('user_id', userIds)
        .order('is_default', { ascending: false });
      
      console.log('[Manual] Endereços encontrados:', addresses?.length || 0);
      
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
      
      // Build customer list with metrics
      const now = new Date();
      const customers: ManualCustomer[] = profiles
        .map(profile => {
          const addr = addresses?.find(a => a.user_id === profile.user_id);
          if (!addr) return null;
          
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
            city: addr.city,
            neighborhood: addr.neighborhood,
            address: {
              street: addr.street,
              number: addr.number,
              neighborhood: addr.neighborhood,
              city: addr.city,
              state: addr.state,
              zip_code: addr.zip_code,
              complement: addr.complement || undefined,
            },
            lastVisitDate,
            lastOrderDate,
            daysSinceLastVisit,
            daysSinceLastOrder,
          };
        })
        .filter(Boolean) as ManualCustomer[];
      
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
      toast({ title: 'Erro ao carregar clientes', variant: 'destructive' });
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
      const ids = [...new Set(data.map((v: any) => v.customer_user_id))];
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', ids);
      const nameMap = new Map((profs || []).map((p: any) => [p.user_id, p.name]));
      const enriched = data.map((v: any) => ({ ...v, customerName: nameMap.get(v.customer_user_id) || 'Cliente' }));
      
      setTodayVisits(enriched);
      
      // Build active check-in status map
      const statusMap = new Map<string, VisitStatus>();
      enriched.forEach((visit: any) => {
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
        toast({ title: 'Check-in realizado!', description: `Visita iniciada: ${customer.name}` });
      } catch (err) {
        console.error('Check-in error:', err);
        toast({ title: 'Erro ao fazer check-in', variant: 'destructive' });
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
      toast({ title: 'Check-out realizado!', description: `Visita finalizada: ${customerName}` });
      
      if (result === 'pedido_fechado') {
        navigate(`/sales/new?customer=${userId}`);
      }
    } catch (err) {
      console.error('Check-out error:', err);
      toast({ title: 'Erro ao fazer check-out', variant: 'destructive' });
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
        toast({ title: 'Check-in realizado!', description: `Visita iniciada: ${stop.customerName}` });
      } catch (err) {
        toast({ title: 'Erro ao fazer check-in', variant: 'destructive' });
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
      (overdueTools || []).forEach((t: any) => {
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
      }, new Map<string, any>());

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

    switch (planningMode) {
      case 'logistica': return upgraded.filter(s => s.stopType === 'pickup_tools' || s.stopType === 'deliver_tools');
      case 'comercial': return [...uniqueCommercial, ...upgraded.filter(s => s.stopType === 'hybrid_visit')];
      case 'hibrido': return [...upgraded, ...uniqueCommercial];
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
    }
  }, [logisticStops, commercialStops, planningMode, selectedCustomerIds, manualCustomers]);

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;
    leafletMap.current = L.map(mapRef.current).setView([-20.14, -44.88], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(leafletMap.current);
    markersRef.current = L.layerGroup().addTo(leafletMap.current);
    return () => { leafletMap.current?.remove(); leafletMap.current = null; };
  }, [loading]);

  // Geocode stops progressively (max 15, 1.1s delay between calls)
  const geocodedCoords = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const geocodingAbort = useRef<AbortController | null>(null);

  const [geocodedAllStops, setGeocodedAllStops] = useState<RouteStop[]>([]);

  // Immediately show stops without waiting for geocoding
  useEffect(() => {
    const enriched = allStops.map(s => {
      const cached = geocodedCoords.current.get(s.id);
      return cached ? { ...s, lat: cached.lat, lng: cached.lng } : s;
    });
    setGeocodedAllStops(enriched);
  }, [allStops]);

  // Background geocoding: max 15 stops, sequential with 1.1s delay
  useEffect(() => {
    geocodingAbort.current?.abort();
    const controller = new AbortController();
    geocodingAbort.current = controller;

    const toGeocode = allStops
      .filter(s => s.address.street && !geocodedCoords.current.has(s.id))
      .slice(0, 15); // Limit to 15

    if (toGeocode.length === 0) return;

    setGeocoding(true);

    (async () => {
      for (const stop of toGeocode) {
        if (controller.signal.aborted) break;
        try {
          const query = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}, Brazil`;
          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
            { signal: controller.signal }
          );
          const data = await res.json();
          if (data?.[0]) {
            const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
            geocodedCoords.current.set(stop.id, coords);
            // Update state progressively
            setGeocodedAllStops(prev => prev.map(s =>
              s.id === stop.id ? { ...s, lat: coords.lat, lng: coords.lng } : s
            ));
          }
        } catch (e: any) {
          if (e?.name === 'AbortError') break;
          console.warn('Geocode failed for', stop.address.street);
        }
        // Nominatim rate limit: max 1 req/sec
        if (!controller.signal.aborted) {
          await new Promise(r => setTimeout(r, 1100));
        }
      }
      if (!controller.signal.aborted) setGeocoding(false);
    })();

    return () => controller.abort();
  }, [allStops]);

  // Filter by period
  const filteredStops = useMemo(() => {
    if (filterPeriod === 'all') return geocodedAllStops;
    return geocodedAllStops.filter(s => s.timeSlot === filterPeriod || !s.timeSlot);
  }, [geocodedAllStops, filterPeriod]);

  // Optimize route: priority-grouped nearest-neighbor
  const optimizedRoute = useMemo(() => {
    if (filteredStops.length <= 1) return filteredStops;

    const withCoords = filteredStops.filter(s => s.lat && s.lng);
    const withoutCoords = filteredStops.filter(s => !s.lat || !s.lng)
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
  }, [filteredStops, filterPeriod]);

  // Update map markers
  useEffect(() => {
    if (!leafletMap.current || !markersRef.current) return;
    markersRef.current.clearLayers();
    routeLineRef.current?.remove();

    const stopsWithCoords = optimizedRoute.filter(s => s.lat && s.lng);
    if (stopsWithCoords.length === 0) return;

    stopsWithCoords.forEach((stop, idx) => {
      const cfg = STOP_CONFIG[stop.stopType];
      const icon = L.divIcon({
        className: 'custom-marker',
        html: `<div style="
          background: ${cfg.markerColor};
          color: white; width: 28px; height: 28px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 13px; border: 2px solid white;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        ">${idx + 1}</div>`,
        iconSize: [28, 28], iconAnchor: [14, 14],
      });

      const hoursLabel = stop.businessHoursOpen && stop.businessHoursClose
        ? `${stop.businessHoursOpen} - ${stop.businessHoursClose}` : 'Não informado';

      L.marker([stop.lat!, stop.lng!], { icon })
        .bindPopup(`
          <strong>${idx + 1}. ${stop.customerName}</strong><br/>
          <span style="color: ${cfg.markerColor}; font-weight: 600">${cfg.label}</span><br/>
          ${stop.address.street}, ${stop.address.number}<br/>
          ${stop.address.neighborhood} - ${stop.address.city}<br/>
          <em>${stop.visitReason}</em><br/>
          <em>Horário: ${hoursLabel}</em>
        `)
        .addTo(markersRef.current!);
    });

    const coords: L.LatLngExpression[] = stopsWithCoords.map(s => [s.lat!, s.lng!]);
    if (coords.length > 1) {
      routeLineRef.current = L.polyline(coords, {
        color: 'hsl(var(--primary))', weight: 3, opacity: 0.7, dashArray: '8, 8',
      }).addTo(leafletMap.current);
    }
    const bounds = L.latLngBounds(coords);
    leafletMap.current.fitBounds(bounds, { padding: [40, 40] });
  }, [optimizedRoute]);

  const openInWaze = (stop: RouteStop) => {
    if (stop.lat && stop.lng) {
      window.open(`https://waze.com/ul?ll=${stop.lat},${stop.lng}&navigate=yes`, '_blank');
    } else {
      const q = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}`;
      window.open(`https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`, '_blank');
    }
  };

  const openInGoogleMaps = (stop: RouteStop) => {
    if (stop.lat && stop.lng) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`, '_blank');
    } else {
      const q = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}`;
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`, '_blank');
    }
  };

  const getStopIcon = (type: StopType) => {
    switch (type) {
      case 'pickup_tools': return <Truck className="w-3.5 h-3.5" />;
      case 'deliver_tools': return <Truck className="w-3.5 h-3.5" />;
      case 'sales_visit': return <ShoppingBag className="w-3.5 h-3.5" />;
      case 'hybrid_visit': return <Layers className="w-3.5 h-3.5" />;
      case 'manual_visit': return <Users className="w-3.5 h-3.5" />;
    }
  };
  
  const getVisitBadge = (customer: ManualCustomer) => {
    if (customer.daysSinceLastVisit === null) {
      return <Badge variant="danger" className="text-xs">Nunca visitado</Badge>;
    }
    if (customer.daysSinceLastVisit > 30) {
      return <Badge variant="warning" className="text-xs">Última visita há {customer.daysSinceLastVisit} dias</Badge>;
    }
    return null;
  };
  
  const getOrderBadge = (customer: ManualCustomer) => {
    if (customer.daysSinceLastOrder === null) {
      return null;
    }
    if (customer.daysSinceLastOrder > 90) {
      return <Badge variant="danger" className="text-xs">Sem compra há {customer.daysSinceLastOrder} dias</Badge>;
    }
    if (customer.daysSinceLastOrder > 30) {
      return <Badge variant="warning" className="text-xs">Comprou há {customer.daysSinceLastOrder} dias</Badge>;
    }
    if (customer.daysSinceLastOrder <= 30) {
      return <Badge variant="success" className="text-xs">Comprou recentemente</Badge>;
    }
    return null;
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

  const getCTALabel = (stop: RouteStop) => {
    if (stop.orderId) return 'Ver pedido';
    if (stop.visitReason.includes('afiação vencida')) return 'Criar pedido de afiação';
    return 'Criar pedido';
  };

  // Stats
  const stopCounts = useMemo(() => {
    const counts = { pickup_tools: 0, deliver_tools: 0, sales_visit: 0, hybrid_visit: 0 };
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

  const formatDuration = (min: number) => {
    if (min < 60) return `${min}min`;
    const h = Math.floor(min / 60);
    const m = min % h;
    return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  };

  const isLoading = authLoading || loading;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Roteirizador" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!isStaff) return null;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Roteirizador" showBack />

      <main className="pt-16 px-4 max-w-4xl mx-auto space-y-4">
        {/* Planning mode selector */}
        <div className="flex items-center gap-2">
          <Route className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">Modo:</span>
          {([
            { key: 'logistica' as PlanningMode, label: 'Logística', icon: <Truck className="w-3.5 h-3.5" /> },
            { key: 'comercial' as PlanningMode, label: 'Comercial', icon: <ShoppingBag className="w-3.5 h-3.5" /> },
            { key: 'hibrido' as PlanningMode, label: 'Híbrido', icon: <Layers className="w-3.5 h-3.5" /> },
            { key: 'manual' as PlanningMode, label: 'Manual', icon: <Users className="w-3.5 h-3.5" /> },
          ]).map(mode => (
            <Button
              key={mode.key}
              variant={planningMode === mode.key ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPlanningMode(mode.key)}
              className="gap-1.5"
            >
              {mode.icon}
              {mode.label}
            </Button>
          ))}
        </div>
        
        {/* Manual mode UI */}
        {planningMode === 'manual' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span>Selecionar Clientes</span>
                <Badge variant="outline">
                  {selectedCustomerIds.size} selecionados · ~{estimatedManualHours}h estimadas
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Filters */}
              <div className="flex items-center gap-2 flex-wrap">
                {(['todos', 'nunca_visitados', 'sem_compra_30d'] as ManualFilter[]).map(filter => (
                  <Button
                    key={filter}
                    variant={manualFilter === filter ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setManualFilter(filter)}
                  >
                    {filter === 'todos' ? 'Todos' : filter === 'nunca_visitados' ? 'Nunca visitados' : 'Sem compra há 30+ dias'}
                  </Button>
                ))}
              </div>
              
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por nome, cidade, bairro..."
                  value={manualSearch}
                  onChange={(e) => setManualSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              
              {/* Customer list */}
              {loadingManual ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {filteredManualCustomers.map(customer => {
                    const isSelected = selectedCustomerIds.has(customer.user_id);
                    const visitStatus = visitStatuses.get(customer.user_id);
                    
                    return (
                      <div
                        key={customer.user_id}
                        className={`p-3 border rounded-lg hover:bg-muted/50 transition-colors ${isSelected ? 'bg-primary/5 border-primary' : ''}`}
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleCustomerSelection(customer.user_id)}
                            className="mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <p className="font-medium text-sm">{customer.name}</p>
                              {getVisitBadge(customer)}
                              {getOrderBadge(customer)}
                              {visitStatus?.isCheckedIn && (
                                <Badge variant="success" className="text-xs gap-1">
                                  <CheckCircle2 className="w-3 h-3" />
                                  Em visita · {formatTimer(visitTimers.get(customer.user_id) ?? 0)}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {customer.neighborhood}, {customer.city}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {customer.address.street}, {customer.address.number}
                            </p>
                            
                            {/* Check-in/Check-out buttons */}
                            {isSelected && (
                              <div className="mt-2 flex gap-2">
                                {!visitStatus?.isCheckedIn ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleCheckIn(customer)}
                                    className="text-xs h-7"
                                  >
                                    <CheckCircle2 className="w-3 h-3 mr-1" />
                                    Check-in
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openCheckoutDialog(customer.user_id, customer.name)}
                                    className="text-xs h-7 border-orange-400 text-orange-600 hover:bg-orange-50"
                                  >
                                    <XCircle className="w-3 h-3 mr-1" />
                                    Check-out
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  
                  {filteredManualCustomers.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      Nenhum cliente encontrado
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Period filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Período:</span>
          {(['all', 'manha', 'tarde'] as FilterPeriod[]).map(period => (
            <Button
              key={period}
              variant={filterPeriod === period ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setFilterPeriod(period)}
            >
              {period === 'all' ? 'Todos' : period === 'manha' ? 'Manhã' : 'Tarde'}
            </Button>
          ))}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {([
            { type: 'pickup_tools' as StopType, icon: Truck },
            { type: 'deliver_tools' as StopType, icon: Truck },
            { type: 'sales_visit' as StopType, icon: ShoppingBag },
            { type: 'hybrid_visit' as StopType, icon: Layers },
          ]).filter(s => {
            if (planningMode === 'logistica') return s.type === 'pickup_tools' || s.type === 'deliver_tools';
            if (planningMode === 'comercial') return s.type === 'sales_visit' || s.type === 'hybrid_visit';
            return true;
          }).map(s => {
            const cfg = STOP_CONFIG[s.type];
            return (
              <Card key={s.type}>
                <CardContent className="pt-3 pb-2 px-3 flex items-center gap-2">
                  <div className={`p-1.5 rounded-md ${cfg.bgClass}`}>
                    <s.icon className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-lg font-bold text-foreground">{stopCounts[s.type]}</p>
                    <p className="text-[10px] text-muted-foreground leading-tight">{cfg.label}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Map */}
        <Card className="overflow-hidden">
          <div ref={mapRef} className="w-full h-[350px] md:h-[450px]" style={{ zIndex: 1 }} />
          {geocoding && (
            <div className="flex items-center gap-2 p-3 bg-muted/50 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Geocodificando endereços...
            </div>
          )}
        </Card>

        {/* Route action buttons */}
        {optimizedRoute.some(s => s.lat && s.lng) && (
          <div className="flex gap-2">
            <Button
              className="flex-1 gap-2"
              onClick={() => {
                const stopsWithCoords = optimizedRoute.filter(s => s.lat && s.lng).slice(0, 25);
                const tooMany = optimizedRoute.filter(s => s.lat && s.lng).length > 25;

                if (tooMany) {
                  toast({ title: 'Google Maps suporta até 25 paradas', description: 'Mostrando as 25 de maior prioridade.' });
                }

                const waypoints = stopsWithCoords.map(s => `${s.lat},${s.lng}`);

                // Try to get current location as origin
                if (navigator.geolocation) {
                  navigator.geolocation.getCurrentPosition(
                    (pos) => {
                      const origin = `${pos.coords.latitude},${pos.coords.longitude}`;
                      const url = `https://www.google.com/maps/dir/${origin}/${waypoints.join('/')}`;
                      window.open(url, '_blank');
                    },
                    () => {
                      // Fallback: start from first waypoint
                      const url = `https://www.google.com/maps/dir/${waypoints.join('/')}`;
                      window.open(url, '_blank');
                    },
                    { timeout: 5000 }
                  );
                } else {
                  const url = `https://www.google.com/maps/dir/${waypoints.join('/')}`;
                  window.open(url, '_blank');
                }
              }}
            >
              <Navigation className="w-4 h-4" />
              Abrir rota no Google Maps
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                const first = optimizedRoute.find(s => s.lat && s.lng);
                if (first) {
                  window.open(`https://waze.com/ul?ll=${first.lat},${first.lng}&navigate=yes`, '_blank');
                }
              }}
            >
              <ExternalLink className="w-4 h-4" />
              Waze
            </Button>
          </div>
        )}


        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Navigation className="w-5 h-5 text-primary" />
            Rota Otimizada
            <Badge variant="outline" className="ml-auto text-xs">
              {optimizedRoute.length} paradas — ~{formatDuration(totalEstimatedMin.totalMin)}
            </Badge>
          </h2>

          {scoringLoading && (planningMode === 'comercial' || planningMode === 'hibrido') && (
            <Card>
              <CardContent className="py-6 flex items-center justify-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Calculando oportunidades comerciais...</span>
              </CardContent>
            </Card>
          )}

          {optimizedRoute.length === 0 && !scoringLoading ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {planningMode === 'logistica' ? 'Nenhum pedido com coleta/entrega pendente.'
                  : planningMode === 'comercial' ? 'Nenhuma visita comercial disponível. Configure datas de afiação nas ferramentas dos clientes para ativar visitas preventivas.'
                  : 'Nenhuma parada encontrada.'}
              </CardContent>
            </Card>
          ) : optimizedRoute.length > 0 ? (
            optimizedRoute.map((stop, idx) => {
              const cfg = STOP_CONFIG[stop.stopType];
              return (
                <Card key={stop.id} className={`hover:shadow-md transition-shadow ${visitStatuses.get(stop.customerUserId)?.isCheckedIn ? 'border-green-400 bg-green-50/40 dark:bg-green-950/20' : ''}`}>
                  <CardContent className="py-3 px-4">
                    <div className="flex items-start gap-3">
                      {/* Number circle colored by type */}
                      <div
                        className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm text-white"
                        style={{ backgroundColor: cfg.markerColor }}
                      >
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="font-semibold text-foreground truncate">{stop.customerName}</p>
                          <Badge className={`text-[10px] px-1.5 py-0 ${cfg.bgClass} border-0`}>
                            {getStopIcon(stop.stopType)}
                            <span className="ml-1">{cfg.label}</span>
                          </Badge>
                          {(() => {
                            const pCfg = PRIORITY_CONFIG[stop.priorityLabel];
                            const PIcon = pCfg.icon;
                            return (
                              <Badge className={`text-[10px] px-1.5 py-0 ${pCfg.bgClass} border-0 gap-0.5`} title={stop.priorityFactors.join(', ')}>
                                <PIcon className="w-3 h-3" />
                                {pCfg.label}
                              </Badge>
                            );
                          })()}
                        </div>
                        <p className="text-sm text-muted-foreground truncate">
                          {stop.address.street}, {stop.address.number} - {stop.address.neighborhood}
                        </p>
                        <p className="text-xs text-muted-foreground/80 mt-0.5 line-clamp-2">
                          {stop.visitReason}
                        </p>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            ~{STOP_DURATION_MIN[stop.stopType]}min
                          </span>
                          {stop.timeSlot && (
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {stop.timeSlot === 'manha' ? 'Manhã' : 'Tarde'}
                            </span>
                          )}
                          {stop.businessHoursOpen && (
                            <span>Funciona: {stop.businessHoursOpen} - {stop.businessHoursClose || '?'}</span>
                          )}
                          {!stop.lat && <span className="text-destructive">Sem coordenadas</span>}
                        </div>
                        {/* CTAs */}
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleStopCTA(stop)}>
                            {getCTALabel(stop)}
                          </Button>
                          {stop.phone && (
                            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" asChild>
                              <a href={`tel:${stop.phone}`}>
                                <Phone className="w-3 h-3" /> Ligar
                              </a>
                            </Button>
                          )}
                          {(() => {
                            const vs = visitStatuses.get(stop.customerUserId);
                            if (!vs?.isCheckedIn) {
                              return (
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs gap-1 border-green-500 text-green-600 hover:bg-green-50 dark:hover:bg-green-950"
                                  onClick={() => handleCheckInStop(stop)}
                                >
                                  <CheckCircle2 className="w-3 h-3" /> Check-in
                                </Button>
                              );
                            }
                            return (
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-mono text-green-600">
                                  {formatTimer(visitTimers.get(stop.customerUserId) ?? 0)}
                                </span>
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs gap-1 border-orange-400 text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-950"
                                  onClick={() => openCheckoutDialog(stop.customerUserId, stop.customerName)}
                                >
                                  <XCircle className="w-3 h-3" /> Check-out
                                </Button>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="outline" className="flex-shrink-0 h-9 w-9">
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openInWaze(stop)}>Abrir no Waze</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openInGoogleMaps(stop)}>Abrir no Google Maps</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          ) : null}
        </div>
        {/* Visitas Realizadas Hoje */}
        <div className="space-y-2 pt-4">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-primary" />
            Visitas Realizadas Hoje
            <Badge variant="outline" className="ml-auto text-xs">{todayVisits.length}</Badge>
          </h2>
          
          {todayVisits.length === 0 ? (
            <Card>
              <CardContent className="py-6 text-center text-muted-foreground text-sm">
                Nenhuma visita registrada hoje
              </CardContent>
            </Card>
          ) : (
            [...todayVisits].sort((a: any, b: any) => {
              if (!a.check_out_at && b.check_out_at) return -1;
              if (a.check_out_at && !b.check_out_at) return 1;
              return 0;
            }).map((visit: any) => {
              const isActive = !visit.check_out_at;
              const duration = visit.check_out_at && visit.check_in_at
                ? Math.floor((new Date(visit.check_out_at).getTime() - new Date(visit.check_in_at).getTime()) / 60000)
                : null;
              const checkInTime = visit.check_in_at
                ? new Date(visit.check_in_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                : '—';
              return (
                <Card key={visit.id} className={isActive ? 'border-green-400' : ''}>
                  <CardContent className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isActive ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{visit.customerName}</p>
                        <p className="text-xs text-muted-foreground">
                          Check-in: {checkInTime}
                          {duration !== null && ` · ${duration}min`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {isActive ? (
                          <Badge variant="success" className="text-xs">Em visita</Badge>
                        ) : visit.result ? (
                          <Badge variant={visit.result === 'pedido_fechado' ? 'success' : 'outline'} className="text-xs">
                            {visit.result === 'pedido_fechado' ? 'Pedido fechado'
                              : visit.result === 'interesse' ? 'Interesse'
                              : visit.result === 'sem_interesse' ? 'Sem interesse'
                              : visit.result === 'ausente' ? 'Ausente'
                              : visit.result === 'reagendar' ? 'Reagendar'
                              : visit.result}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </main>

      {/* Checkout Dialog */}
      <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Check-out — {checkoutTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Resultado da visita *</Label>
              <Select value={checkoutResult} onValueChange={setCheckoutResult}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="Selecione o resultado..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pedido_fechado">✅ Pedido fechado</SelectItem>
                  <SelectItem value="interesse">🤔 Interesse</SelectItem>
                  <SelectItem value="sem_interesse">❌ Sem interesse</SelectItem>
                  <SelectItem value="ausente">🚫 Ausente</SelectItem>
                  <SelectItem value="reagendar">📅 Reagendar</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {checkoutResult === 'pedido_fechado' && (
              <div>
                <Label>Receita gerada (R$)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0,00"
                  value={checkoutRevenue}
                  onChange={e => setCheckoutRevenue(e.target.value)}
                  className="mt-1.5"
                />
              </div>
            )}
            
            <div>
              <Label>Observações (opcional)</Label>
              <Textarea
                placeholder="Notas sobre a visita..."
                value={checkoutNotes}
                onChange={e => setCheckoutNotes(e.target.value)}
                className="mt-1.5 resize-none"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCheckoutOpen(false)}>Cancelar</Button>
            <Button disabled={!checkoutResult} onClick={confirmCheckout}>
              Confirmar Check-out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BottomNav />
    </div>
  );
};

export default AdminRoutePlanner;
