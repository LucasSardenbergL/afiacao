import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, MapPin, Clock, Route, Filter, Navigation } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default marker icons for Leaflet + bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

interface RouteStop {
  orderId: string;
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
  deliveryOption: string;
  lat?: number;
  lng?: number;
  items: unknown;
  total: number;
}

type FilterPeriod = 'all' | 'manha' | 'tarde';

const AdminRoutePlanner = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);

  const [stops, setStops] = useState<RouteStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [geocoding, setGeocoding] = useState(false);
  const [filterPeriod, setFilterPeriod] = useState<FilterPeriod>('all');

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      loadPendingOrders();
    }
  }, [user, isStaff]);

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;

    leafletMap.current = L.map(mapRef.current).setView([-23.55, -46.63], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(leafletMap.current);

    markersRef.current = L.layerGroup().addTo(leafletMap.current);

    return () => {
      leafletMap.current?.remove();
      leafletMap.current = null;
    };
  }, [loading]);

  const loadPendingOrders = async () => {
    try {
      // Load orders that need pickup/delivery (not delivered yet)
      const { data: orders, error } = await supabase
        .from('orders')
        .select('*')
        .in('status', ['pedido_recebido', 'em_producao', 'pronto', 'em_transito'])
        .eq('delivery_option', 'pickup');

      if (error) throw error;
      if (!orders || orders.length === 0) {
        setLoading(false);
        return;
      }

      // Load profiles for business hours
      const userIds = [...new Set(orders.map(o => o.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, phone, business_hours_open, business_hours_close')
        .in('user_id', userIds);

      // Load addresses
      const { data: addresses } = await supabase
        .from('addresses')
        .select('*')
        .in('user_id', userIds);

      const routeStops: RouteStop[] = orders.map(order => {
        const profile = profiles?.find(p => p.user_id === order.user_id);
        const orderAddress = order.address as any;
        const defaultAddr = addresses?.find(
          a => a.user_id === order.user_id && a.is_default
        ) || addresses?.find(a => a.user_id === order.user_id);

        const addr = orderAddress || defaultAddr;

        return {
          orderId: order.id,
          customerName: profile?.name || 'Cliente',
          phone: profile?.phone || null,
          address: addr ? {
            street: addr.street || '',
            number: addr.number || '',
            neighborhood: addr.neighborhood || '',
            city: addr.city || '',
            state: addr.state || '',
            zip_code: addr.zip_code || '',
            complement: addr.complement || undefined,
          } : {
            street: '', number: '', neighborhood: '', city: '', state: '', zip_code: '',
          },
          timeSlot: order.time_slot,
          businessHoursOpen: profile?.business_hours_open || null,
          businessHoursClose: profile?.business_hours_close || null,
          status: order.status,
          deliveryOption: order.delivery_option,
          items: order.items,
          total: order.total,
        };
      });

      setStops(routeStops);
      await geocodeStops(routeStops);
    } catch (error) {
      console.error('Error loading orders for route:', error);
      toast({
        title: 'Erro ao carregar pedidos',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const geocodeStops = async (routeStops: RouteStop[]) => {
    setGeocoding(true);
    const geocoded = await Promise.all(
      routeStops.map(async (stop) => {
        if (!stop.address.street) return stop;
        try {
          const query = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}, Brazil`;
          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`
          );
          const data = await res.json();
          if (data && data.length > 0) {
            return { ...stop, lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
          }
        } catch (e) {
          console.warn('Geocode failed for', stop.address.street);
        }
        return stop;
      })
    );
    setStops(geocoded);
    setGeocoding(false);
  };

  // Filter stops by period
  const filteredStops = useMemo(() => {
    if (filterPeriod === 'all') return stops;
    return stops.filter(s => s.timeSlot === filterPeriod);
  }, [stops, filterPeriod]);

  // Optimize route using nearest-neighbor, considering time slots and business hours
  const optimizedRoute = useMemo(() => {
    const stopsWithCoords = filteredStops.filter(s => s.lat && s.lng);
    if (stopsWithCoords.length <= 1) return stopsWithCoords;

    // Sort: morning first, then afternoon, then by nearest neighbor within each group
    const morning = stopsWithCoords.filter(s => s.timeSlot === 'manha' || !s.timeSlot);
    const afternoon = stopsWithCoords.filter(s => s.timeSlot === 'tarde');

    const optimizeGroup = (group: RouteStop[]): RouteStop[] => {
      if (group.length <= 1) return group;

      // Sort by business hours open time first
      const sorted = [...group].sort((a, b) => {
        const aOpen = a.businessHoursOpen || '08:00';
        const bOpen = b.businessHoursOpen || '08:00';
        return aOpen.localeCompare(bOpen);
      });

      // Nearest neighbor from the first stop
      const result: RouteStop[] = [sorted[0]];
      const remaining = sorted.slice(1);

      while (remaining.length > 0) {
        const last = result[result.length - 1];
        let nearestIdx = 0;
        let nearestDist = Infinity;

        remaining.forEach((stop, idx) => {
          const dist = Math.sqrt(
            Math.pow((stop.lat! - last.lat!) * 111, 2) +
            Math.pow((stop.lng! - last.lng!) * 111 * Math.cos(last.lat! * Math.PI / 180), 2)
          );
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestIdx = idx;
          }
        });

        result.push(remaining.splice(nearestIdx, 1)[0]);
      }

      return result;
    };

    if (filterPeriod === 'tarde') return optimizeGroup(afternoon);
    if (filterPeriod === 'manha') return optimizeGroup(morning);
    return [...optimizeGroup(morning), ...optimizeGroup(afternoon)];
  }, [filteredStops, filterPeriod]);

  // Update map markers and route line
  useEffect(() => {
    if (!leafletMap.current || !markersRef.current) return;

    markersRef.current.clearLayers();
    routeLineRef.current?.remove();

    const stopsWithCoords = optimizedRoute.filter(s => s.lat && s.lng);
    if (stopsWithCoords.length === 0) return;

    stopsWithCoords.forEach((stop, idx) => {
      const icon = L.divIcon({
        className: 'custom-marker',
        html: `<div style="
          background: hsl(0 84% 50%);
          color: white;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 13px;
          border: 2px solid white;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        ">${idx + 1}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const periodLabel = stop.timeSlot === 'manha' ? 'Manhã' : stop.timeSlot === 'tarde' ? 'Tarde' : '—';
      const hoursLabel = stop.businessHoursOpen && stop.businessHoursClose
        ? `${stop.businessHoursOpen} - ${stop.businessHoursClose}`
        : 'Não informado';

      L.marker([stop.lat!, stop.lng!], { icon })
        .bindPopup(`
          <strong>${idx + 1}. ${stop.customerName}</strong><br/>
          ${stop.address.street}, ${stop.address.number}<br/>
          ${stop.address.neighborhood} - ${stop.address.city}<br/>
          <em>Período: ${periodLabel}</em><br/>
          <em>Horário: ${hoursLabel}</em>
        `)
        .addTo(markersRef.current!);
    });

    // Draw route line
    const coords: L.LatLngExpression[] = stopsWithCoords.map(s => [s.lat!, s.lng!]);
    if (coords.length > 1) {
      routeLineRef.current = L.polyline(coords, {
        color: 'hsl(0, 84%, 50%)',
        weight: 3,
        opacity: 0.7,
        dashArray: '8, 8',
      }).addTo(leafletMap.current);
    }

    // Fit bounds
    const bounds = L.latLngBounds(coords);
    leafletMap.current.fitBounds(bounds, { padding: [40, 40] });
  }, [optimizedRoute]);

  const getStatusLabel = (status: string) => {
    const map: Record<string, string> = {
      pedido_recebido: 'Recebido',
      em_producao: 'Em Produção',
      pronto: 'Pronto',
      em_transito: 'Em Trânsito',
    };
    return map[status] || status;
  };

  if (authLoading || loading) {
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
        {/* Period filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Filtrar:</span>
          {(['all', 'manha', 'tarde'] as FilterPeriod[]).map(period => (
            <Button
              key={period}
              variant={filterPeriod === period ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilterPeriod(period)}
            >
              {period === 'all' ? 'Todos' : period === 'manha' ? 'Manhã' : 'Tarde'}
            </Button>
          ))}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <MapPin className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold text-foreground">{optimizedRoute.length}</p>
                <p className="text-xs text-muted-foreground">Paradas</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Route className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold text-foreground">
                  {optimizedRoute.filter(s => s.lat && s.lng).length}
                </p>
                <p className="text-xs text-muted-foreground">Geolocalizados</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Map */}
        <Card className="overflow-hidden">
          <div
            ref={mapRef}
            className="w-full h-[350px] md:h-[450px]"
            style={{ zIndex: 1 }}
          />
          {geocoding && (
            <div className="flex items-center gap-2 p-3 bg-muted/50 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Geocodificando endereços...
            </div>
          )}
        </Card>

        {/* Ordered stop list */}
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Navigation className="w-5 h-5 text-primary" />
            Rota Otimizada
          </h2>

          {optimizedRoute.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                Nenhum pedido com coleta pendente encontrado.
              </CardContent>
            </Card>
          ) : (
            optimizedRoute.map((stop, idx) => (
              <Card
                key={stop.orderId}
                className="cursor-pointer hover:shadow-medium transition-shadow"
                onClick={() => navigate(`/admin/orders/${stop.orderId}`)}
              >
                <CardContent className="py-3 px-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm">
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <p className="font-semibold text-foreground truncate">
                          {stop.customerName}
                        </p>
                        <Badge variant="outline" className="text-xs ml-2 flex-shrink-0">
                          {getStatusLabel(stop.status)}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground truncate">
                        {stop.address.street}, {stop.address.number} - {stop.address.neighborhood}
                      </p>
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {stop.timeSlot === 'manha' ? 'Manhã' : stop.timeSlot === 'tarde' ? 'Tarde' : '—'}
                        </span>
                        {stop.businessHoursOpen && (
                          <span>
                            Funciona: {stop.businessHoursOpen} - {stop.businessHoursClose || '?'}
                          </span>
                        )}
                        {!stop.lat && (
                          <span className="text-destructive">Sem coordenadas</span>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminRoutePlanner;
