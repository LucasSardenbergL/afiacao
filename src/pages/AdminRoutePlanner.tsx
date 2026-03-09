import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { useToast } from '@/hooks/use-toast';
import { Loader2, MapPin, Clock, Route, Filter, Navigation, ExternalLink, Truck, ShoppingBag, Wrench, Layers, Phone, ArrowUp, ArrowRight, ArrowDown } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default marker icons for Leaflet + bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

type StopType = 'pickup_tools' | 'deliver_tools' | 'sales_visit' | 'hybrid_visit';
type PlanningMode = 'logistica' | 'comercial' | 'hibrido';
type FilterPeriod = 'all' | 'manha' | 'tarde';

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
    }
  }, [logisticStops, commercialStops, planningMode]);

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;
    leafletMap.current = L.map(mapRef.current).setView([-23.55, -46.63], 11);
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
    }
  };

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
                <Card key={stop.id} className="hover:shadow-md transition-shadow">
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
                        <div className="flex items-center gap-2 mt-2">
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
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminRoutePlanner;
