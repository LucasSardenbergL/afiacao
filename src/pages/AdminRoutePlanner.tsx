import { useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Navigation, CheckCircle2 } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { formatDuration } from '@/components/reposicao/routePlanner/renderHelpers';
import { STOP_CONFIG } from '@/components/reposicao/routePlanner/constants';
import { StatsStrip } from '@/components/reposicao/routePlanner/StatsStrip';
import { RouteStopCard } from '@/components/reposicao/routePlanner/RouteStopCard';
import { TodayVisitCard } from '@/components/reposicao/routePlanner/TodayVisitCard';
import { CheckoutDialog } from '@/components/reposicao/routePlanner/CheckoutDialog';
import { PlanningModeSelector } from '@/components/reposicao/routePlanner/PlanningModeSelector';
import { RoutePlannerContextTabs } from '@/components/reposicao/routePlanner/RoutePlannerContextTabs';
import { CityMultiSelector } from '@/components/reposicao/routePlanner/CityMultiSelector';
import { FieldTargetsSummary } from '@/components/reposicao/routePlanner/FieldTargetsSummary';
import { FieldTargetCard } from '@/components/reposicao/routePlanner/FieldTargetCard';
import { PeriodFilter } from '@/components/reposicao/routePlanner/PeriodFilter';
import { RouteActionButtons } from '@/components/reposicao/routePlanner/RouteActionButtons';
import { ManualModeCard } from '@/components/reposicao/routePlanner/ManualModeCard';
import { ScheduledVisitsPanel } from '@/components/reposicao/routePlanner/ScheduledVisitsPanel';
import { useRoutePlanner } from '@/hooks/useRoutePlanner';

// Fix default marker icons for Leaflet + bundlers
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});


const AdminRoutePlanner = () => {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);

  const {
    authLoading,
    isStaff,
    loading,
    geocoding,
    scoringLoading,
    planningMode,
    setPlanningMode,
    filterPeriod,
    setFilterPeriod,
    optimizedRoute,
    stopCounts,
    totalEstimatedMin,
    todayVisits,
    manualFilter,
    setManualFilter,
    manualSearch,
    setManualSearch,
    loadingManual,
    filteredManualCustomers,
    selectedCustomerIds,
    estimatedManualHours,
    visitStatuses,
    visitTimers,
    formatTimer,
    checkoutOpen,
    setCheckoutOpen,
    checkoutTarget,
    checkoutResult,
    setCheckoutResult,
    checkoutNotes,
    setCheckoutNotes,
    checkoutRevenue,
    setCheckoutRevenue,
    toggleCustomerSelection,
    handleCheckIn,
    handleCheckInStop,
    openCheckoutDialog,
    confirmCheckout,
    handleStopCTA,
    openInWaze,
    openInGoogleMaps,
    // contexto campo/equipe
    planningContext,
    setPlanningContext,
    temAcessoCampo,
    selectedCities,
    toggleCity,
    removeCity,
    loadingProspects,
    fieldTargets,
    filteredFieldTargets,
    resumoAlvos,
    selectedTargetIds,
    toggleTargetId,
    targetFilter,
    setTargetFilter,
  } = useRoutePlanner();

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;
    leafletMap.current = L.map(mapRef.current).setView([-20.14, -44.88], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(leafletMap.current);
    markersRef.current = L.layerGroup().addTo(leafletMap.current);
    return () => { leafletMap.current?.remove(); leafletMap.current = null; };
    // Inicializa o mapa quando a tela renderiza (auth pronto), NÃO quando a carga
    // logística termina — senão uma query pendurada travava o mapa junto com a tela.
  }, [authLoading]);

  // Update map markers.
  // No contexto campo: mostra o UNIVERSO de alvos (filtrado); os marcados ganham
  // número (posição na rota) + azul; os não-marcados, a cor do tipo, sem número.
  // No contexto equipe: a rota otimizada numerada (como antes).
  useEffect(() => {
    if (!leafletMap.current || !markersRef.current) return;
    markersRef.current.clearLayers();
    routeLineRef.current?.remove();

    const fonte = planningContext === 'campo' ? filteredFieldTargets : optimizedRoute;
    const ordemRota = new Map(optimizedRoute.map((s, i) => [s.id, i + 1]));

    const fonteComCoords = fonte.filter((s) => s.lat && s.lng);
    if (fonteComCoords.length === 0) return;

    fonteComCoords.forEach((stop) => {
      const numero = ordemRota.get(stop.id);
      const noModoCampo = planningContext === 'campo';
      // Azul de "selecionado pra rota" só no campo; no equipe, cor do tipo (intacto).
      const cor = (noModoCampo && numero != null) ? '#2563eb' : STOP_CONFIG[stop.stopType].markerColor;
      const conteudo = numero != null ? String(numero) : '';
      const icon = L.divIcon({
        className: 'custom-marker',
        html: `<div style="
          background: ${cor};
          color: white; width: 28px; height: 28px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 13px; border: 2px solid white;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        ">${conteudo}</div>`,
        iconSize: [28, 28], iconAnchor: [14, 14],
      });

      const hoursLabel = stop.businessHoursOpen && stop.businessHoursClose
        ? `${stop.businessHoursOpen} - ${stop.businessHoursClose}` : 'Não informado';
      const cfg = STOP_CONFIG[stop.stopType];

      L.marker([stop.lat!, stop.lng!], { icon })
        .bindPopup(`
          <strong>${numero != null ? `${numero}. ` : ''}${stop.customerName}</strong><br/>
          <span style="color: ${cfg.markerColor}; font-weight: 600">${cfg.label}</span><br/>
          ${stop.address.street}, ${stop.address.number}<br/>
          ${stop.address.neighborhood} - ${stop.address.city}<br/>
          <em>${stop.visitReason}</em><br/>
          <em>Horário: ${hoursLabel}</em>
        `)
        .addTo(markersRef.current!);
    });

    // Linha da rota: só os marcados/otimizados (em ambos os contextos).
    const coords: L.LatLngExpression[] = optimizedRoute
      .filter((s) => s.lat && s.lng)
      .map((s) => [s.lat!, s.lng!]);
    if (coords.length > 1) {
      routeLineRef.current = L.polyline(coords, {
        color: 'hsl(var(--primary))', weight: 3, opacity: 0.7, dashArray: '8, 8',
      }).addTo(leafletMap.current);
    }
  }, [optimizedRoute, filteredFieldTargets, planningContext]);

  // fitBounds SEPARADO: re-enquadra só quando o CONJUNTO de pinos muda (cidades/
  // filtro/geocode) — NÃO quando a seleção muda (senão o mapa "pula" enquanto o
  // hunter marca alvos). Guardado por uma chave de ids.
  const lastBoundsKey = useRef('');
  useEffect(() => {
    if (!leafletMap.current) return;
    const fonte = planningContext === 'campo' ? filteredFieldTargets : optimizedRoute;
    const withCoords = fonte.filter((s) => s.lat && s.lng);
    const key = withCoords.map((s) => s.id).join('|');
    if (key && key !== lastBoundsKey.current) {
      leafletMap.current.fitBounds(
        L.latLngBounds(withCoords.map((s) => [s.lat!, s.lng!] as L.LatLngExpression)),
        { padding: [40, 40] },
      );
      lastBoundsKey.current = key;
    }
  }, [planningContext, filteredFieldTargets, optimizedRoute]);

  // Só o auth bloqueia a tela inteira. A carga logística (`loading`) e as demais
  // cargas (scoring/prospects) têm loading INLINE por seção — uma query pendurada
  // (ex.: pedidos) não pode mais travar a tela toda no spinner eterno.
  const isLoading = authLoading;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  if (!isStaff) return null;

  return (
    <div className="min-h-screen bg-background pb-24">

      <main className="pt-16 px-4 max-w-4xl mx-auto space-y-4">
        {/* Abas de contexto — só p/ quem tem acesso ao campo (gestor/master).
            Sem isso, a equipe vê só o conteúdo de "equipe", sem switcher. */}
        {temAcessoCampo && (
          <RoutePlannerContextTabs value={planningContext} onChange={setPlanningContext} />
        )}

        {planningContext === 'campo' ? (
          /* ---------- VISITAS EM CAMPO (hunter) — UI enxuta ---------- */
          <>
            <CityMultiSelector value={selectedCities} onToggle={toggleCity} onRemove={removeCity} />
            {fieldTargets.length > 0 && (
              <FieldTargetsSummary
                totalClientes={resumoAlvos.totalClientes}
                totalProspects={resumoAlvos.totalProspects}
                filtro={targetFilter}
                onFiltroChange={setTargetFilter}
              />
            )}
          </>
        ) : (
          /* ---------- PLANEJAMENTO DA EQUIPE — tela atual idêntica ---------- */
          <>
            <PlanningModeSelector value={planningMode} onChange={setPlanningMode} />

            {planningMode === 'manual' && (
              <ManualModeCard
                selectedCount={selectedCustomerIds.size}
                estimatedHours={estimatedManualHours}
                filter={manualFilter}
                onFilterChange={setManualFilter}
                search={manualSearch}
                onSearchChange={setManualSearch}
                loading={loadingManual}
                customers={filteredManualCustomers}
                isSelected={(id) => selectedCustomerIds.has(id)}
                isCheckedIn={(id) => !!visitStatuses.get(id)?.isCheckedIn}
                timerLabel={(id) => formatTimer(visitTimers.get(id) ?? 0)}
                onToggle={toggleCustomerSelection}
                onCheckIn={handleCheckIn}
                onCheckout={openCheckoutDialog}
              />
            )}

            <PeriodFilter value={filterPeriod} onChange={setFilterPeriod} />
            <StatsStrip planningMode={planningMode} stopCounts={stopCounts} />
            <ScheduledVisitsPanel />
          </>
        )}

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
        <RouteActionButtons optimizedRoute={optimizedRoute} />

        {/* Universo de alvos (contexto campo): marque quem visitar */}
        {planningContext === 'campo' && filteredFieldTargets.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-foreground">
              Alvos nas cidades
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                marque quem visitar hoje
              </span>
            </h2>
            <div className="space-y-1.5">
              {filteredFieldTargets.map((stop) => (
                <FieldTargetCard
                  key={stop.id}
                  stop={stop}
                  naRota={selectedTargetIds.has(stop.id)}
                  onToggleRota={() => toggleTargetId(stop.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Navigation className="w-5 h-5 text-primary" />
            {planningContext === 'campo' ? 'Rota de hoje' : 'Rota Otimizada'}
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
          {loadingProspects && planningMode === 'prospeccao' && (
            <Card>
              <CardContent className="py-6 flex items-center justify-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Carregando prospects...</span>
              </CardContent>
            </Card>
          )}
          {loading && planningMode !== 'prospeccao' && (
            <Card>
              <CardContent className="py-6 flex items-center justify-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Carregando paradas...</span>
              </CardContent>
            </Card>
          )}

          {optimizedRoute.length === 0 && !scoringLoading && !loadingProspects && !loading ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {planningMode === 'logistica' ? 'Nenhum pedido com coleta/entrega pendente.'
                  : planningMode === 'comercial' ? 'Nenhuma visita comercial disponível. Configure datas de afiação nas ferramentas dos clientes para ativar visitas preventivas.'
                  : planningMode === 'prospeccao'
                    ? (fieldTargets.length === 0
                        ? 'Selecione uma ou mais cidades acima para ver os alvos (clientes + prospects).'
                        : 'Marque os alvos que você quer visitar hoje — a rota otimizada aparece aqui.')
                  : 'Nenhuma parada encontrada.'}
              </CardContent>
            </Card>
          ) : optimizedRoute.length > 0 ? (
            optimizedRoute.map((stop, idx) => (
              <RouteStopCard
                key={stop.id}
                stop={stop}
                idx={idx}
                isCheckedIn={stop.stopType === 'prospect_visit' ? false : !!visitStatuses.get(stop.customerUserId)?.isCheckedIn}
                timerLabel={formatTimer(visitTimers.get(stop.customerUserId) ?? 0)}
                onStopCTA={() => handleStopCTA(stop)}
                onCheckIn={() => handleCheckInStop(stop)}
                onCheckout={() => openCheckoutDialog(stop.customerUserId, stop.customerName)}
                onOpenWaze={() => openInWaze(stop)}
                onOpenGoogleMaps={() => openInGoogleMaps(stop)}
              />
            ))
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
            [...todayVisits].sort((a, b) => {
              if (!a.check_out_at && b.check_out_at) return -1;
              if (a.check_out_at && !b.check_out_at) return 1;
              return 0;
            }).map((visit) => (
              <TodayVisitCard key={visit.id} visit={visit} />
            ))
          )}
        </div>
      </main>

      {/* Checkout Dialog */}
      <CheckoutDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        targetName={checkoutTarget?.name}
        result={checkoutResult}
        onResultChange={setCheckoutResult}
        revenue={checkoutRevenue}
        onRevenueChange={setCheckoutRevenue}
        notes={checkoutNotes}
        onNotesChange={setCheckoutNotes}
        onConfirm={confirmCheckout}
      />

    </div>
  );
};

export default AdminRoutePlanner;
