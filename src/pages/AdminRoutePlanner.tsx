import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Navigation, CheckCircle2 } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { formatDuration } from '@/components/rota/planner/renderHelpers';
import { STOP_CONFIG } from '@/components/rota/planner/constants';
import { StatsStrip } from '@/components/rota/planner/StatsStrip';
import { RouteStopCard } from '@/components/rota/planner/RouteStopCard';
import { TodayVisitCard } from '@/components/rota/planner/TodayVisitCard';
import { CheckoutDialog } from '@/components/rota/planner/CheckoutDialog';
import { PlanningModeSelector } from '@/components/rota/planner/PlanningModeSelector';
import { RoutePlannerContextTabs } from '@/components/rota/planner/RoutePlannerContextTabs';
import { CityMultiSelector } from '@/components/rota/planner/CityMultiSelector';
import { FieldTargetsSummary } from '@/components/rota/planner/FieldTargetsSummary';
import { AlvosFiltros } from '@/components/rota/planner/AlvosFiltros';
import { FieldTargetsList } from '@/components/rota/planner/FieldTargetsList';
import { FieldTargetDetailSheet } from '@/components/rota/planner/FieldTargetDetailSheet';
import type { RouteStop } from '@/components/rota/planner/types';
import { PeriodFilter } from '@/components/rota/planner/PeriodFilter';
import { RouteActionButtons } from '@/components/rota/planner/RouteActionButtons';
import { ManualModeCard } from '@/components/rota/planner/ManualModeCard';
import { ScheduledVisitsPanel } from '@/components/rota/planner/ScheduledVisitsPanel';
import { useRoutePlanner } from '@/hooks/useRoutePlanner';
import { escapeHtml } from '@/lib/escape-html';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { markerVisual, clusterStats, precisaoVisual, TONE_CSS, type MarkerTone, type MarkerShape } from '@/lib/route/marker-visual';
import { MapLegend } from '@/components/rota/planner/MapLegend';

// Fix default marker icons for Leaflet + bundlers
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Pino do contexto campo (Sub-PR 4, E): cor = urgência (tom), forma = tipo.
// error ganha borda dupla (reforço p/ daltonismo — não depender só da matiz).
type StopMarker = L.Marker & { __stop?: RouteStop };

function divIconAlvo(tone: MarkerTone, shape: MarkerShape, numero?: number, aproximado = false): L.DivIcon {
  const cor = TONE_CSS[tone];
  const raio = shape === 'circle' ? '50%' : '3px';
  const rot = shape === 'diamond' ? 'rotate(45deg)' : 'none';
  // Aproximado (centróide de município): pino OCO + borda tracejada na cor da
  // urgência — precisão honesta, não finge rooftop. Preciso: preenchido, borda branca.
  const fundo = aproximado ? 'hsl(var(--background))' : cor;
  const borda = aproximado ? `2px dashed ${cor}` : tone === 'error' ? '3px double #fff' : '2px solid #fff';
  const corConteudo = aproximado ? cor : '#fff';
  // número (posição na rota) num filho contra-rotacionado p/ não deitar no losango
  const conteudo = numero != null
    ? `<span style="transform:${shape === 'diamond' ? 'rotate(-45deg)' : 'none'};color:${corConteudo};font-weight:700;font-size:12px">${numero}</span>`
    : '';
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${fundo};width:26px;height:26px;border-radius:${raio};transform:${rot};border:${borda};box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center">${conteudo}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

// Ícone do cluster (Sub-PR 4, E): SEM cor-média — total no centro, borda na MAIOR
// urgência presente, badge !N de quantos vermelhos (1 urgente entre 80 não some).
function iconClusterAlvos(cluster: L.MarkerCluster): L.DivIcon {
  const filhos = cluster.getAllChildMarkers() as StopMarker[];
  const st = clusterStats(filhos.map((m) => m.__stop).filter((s): s is RouteStop => s != null));
  const badge = st.vermelhos > 0
    ? `<span style="position:absolute;top:-6px;right:-6px;background:${TONE_CSS.error};color:#fff;border-radius:9px;font-size:10px;font-weight:700;padding:0 5px;border:1px solid #fff">!${st.vermelhos}</span>`
    : '';
  return L.divIcon({
    className: 'custom-cluster',
    html: `<div style="position:relative;width:40px;height:40px;border-radius:50%;background:hsl(var(--background));border:3px solid ${TONE_CSS[st.maiorUrgencia]};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:hsl(var(--foreground));box-shadow:0 2px 8px rgba(0,0,0,.25)">${st.total}${badge}</div>`,
    iconSize: [40, 40], iconAnchor: [20, 20],
  });
}

const AdminRoutePlanner = () => {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);

  const {
    authLoading,
    isStaff,
    loading,
    geocodingPendentes,
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
    prospectsDisponiveis,
    bairrosDisponiveis,
    selectedTargetIds,
    toggleTargetId,
    filtros,
    setFiltros,
    removerAlvo,
    detalheDoAlvo,
  } = useRoutePlanner();

  // Sheet de detalhe do alvo (contexto campo). alvoAberto = qual alvo está aberto.
  const [alvoAberto, setAlvoAberto] = useState<RouteStop | null>(null);
  const detalheAberto = useMemo(
    () => (alvoAberto ? detalheDoAlvo(alvoAberto) : null),
    [alvoAberto, detalheDoAlvo],
  );
  // Trocar de cidade troca o universo — fecha o detalhe aberto (evita sheet órfão
  // apontando pra um alvo da cidade anterior, cujo raw já foi limpo).
  useEffect(() => { setAlvoAberto(null); }, [selectedCities]);

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;
    leafletMap.current = L.map(mapRef.current).setView([-20.14, -44.88], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(leafletMap.current);
    // O grupo de marcadores (cluster no campo / layerGroup no equipe) é criado no
    // effect de marcadores abaixo — aqui só o mapa + tiles.
    return () => { leafletMap.current?.remove(); leafletMap.current = null; };
    // Inicializa o mapa quando a tela renderiza (auth pronto), NÃO quando a carga
    // logística termina — senão uma query pendurada travava o mapa junto com a tela.
  }, [authLoading]);

  // Update map markers.
  // No contexto campo: mostra o UNIVERSO de alvos (filtrado); os marcados ganham
  // número (posição na rota) + azul; os não-marcados, a cor do tipo, sem número.
  // No contexto equipe: a rota otimizada numerada (como antes).
  useEffect(() => {
    if (!leafletMap.current) return;
    markersRef.current?.remove();
    routeLineRef.current?.remove();

    const noModoCampo = planningContext === 'campo';
    const fonte = noModoCampo ? filteredFieldTargets : optimizedRoute;
    const ordemRota = new Map(optimizedRoute.map((s, i) => [s.id, i + 1]));
    const fonteComCoords = fonte.filter((s) => s.lat && s.lng);

    // Cluster só no campo (600+ pinos viram aglomerados legíveis); no equipe a rota
    // numerada fica sem cluster (a sequência importa). O cluster agrega por urgência.
    const grupo: L.LayerGroup = noModoCampo
      ? L.markerClusterGroup({
          maxClusterRadius: 48,
          showCoverageOnHover: false,
          spiderfyOnMaxZoom: true,
          chunkedLoading: true,
          iconCreateFunction: iconClusterAlvos,
        })
      : L.layerGroup();
    markersRef.current = grupo;

    fonteComCoords.forEach((stop) => {
      const numero = ordemRota.get(stop.id);
      // Precisão honesta (campo): pino oco/tracejado + nota no popup p/ aproximado.
      const aproximado = noModoCampo && precisaoVisual(stop.precisao).aproximado;
      let icon: L.DivIcon;
      if (noModoCampo) {
        // Campo: cor = urgência (mesmo marcado), forma = tipo; número se está na rota.
        const { tone, shape } = markerVisual(stop);
        icon = divIconAlvo(tone, shape, numero, aproximado);
      } else {
        // Equipe: comportamento antigo (cor do tipo, círculo numerado).
        const cor = STOP_CONFIG[stop.stopType].markerColor;
        icon = L.divIcon({
          className: 'custom-marker',
          html: `<div style="background:${cor};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)">${numero != null ? numero : ''}</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14],
        });
      }

      const hoursLabel = stop.businessHoursOpen && stop.businessHoursClose
        ? `${escapeHtml(stop.businessHoursOpen)} - ${escapeHtml(stop.businessHoursClose)}` : 'Não informado';
      const cfg = STOP_CONFIG[stop.stopType];

      // Leaflet renderiza o popup como HTML cru (≈ dangerouslySetInnerHTML) →
      // escapar TODO dado de cliente/prospect (nome, endereço, motivo, horário)
      // antes de interpolar, senão um `<img onerror=…>` no nome vira XSS stored (#862).
      // cfg.label/markerColor e numero são constantes/numéricos (seguros).
      const m = L.marker([stop.lat!, stop.lng!], { icon }) as StopMarker;
      m.__stop = stop; // o cluster lê __stop p/ agregar por urgência (clusterStats)
      m.bindPopup(`
          <strong>${numero != null ? `${numero}. ` : ''}${escapeHtml(stop.customerName)}</strong><br/>
          <span style="color: ${cfg.markerColor}; font-weight: 600">${cfg.label}</span><br/>
          ${escapeHtml(stop.address.street)}, ${escapeHtml(stop.address.number)}<br/>
          ${escapeHtml(stop.address.neighborhood)} - ${escapeHtml(stop.address.city)}<br/>
          <em>${escapeHtml(stop.visitReason)}</em><br/>
          <em>Horário: ${hoursLabel}</em>${aproximado ? '<br/><em>📍 local aproximado (CEP)</em>' : ''}
        `);
      grupo.addLayer(m);
    });

    grupo.addTo(leafletMap.current);

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
        <main className="pt-16 px-4 max-w-4xl mx-auto">
          <PageSkeleton variant="auto" />
        </main>
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
              <>
                <FieldTargetsSummary
                  totalClientes={resumoAlvos.totalClientes}
                  totalProspects={resumoAlvos.totalProspects}
                  prospectsDisponiveis={prospectsDisponiveis}
                />
                <AlvosFiltros
                  filtros={filtros}
                  onChange={(patch) => setFiltros((prev) => ({ ...prev, ...patch }))}
                  bairros={bairrosDisponiveis}
                />
              </>
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
        <Card className="relative overflow-hidden">
          <div ref={mapRef} className="w-full h-[350px] md:h-[450px]" style={{ zIndex: 1 }} />
          {geocodingPendentes > 0 && (
            <div className="pointer-events-none absolute right-3 top-3 z-[400] flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
              <Loader2 className="h-3 w-3 animate-spin" />
              localizando {geocodingPendentes}{planningContext === 'campo' ? ` CEP${geocodingPendentes > 1 ? 's' : ''}` : ''}…
            </div>
          )}
          <MapLegend />
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
            <FieldTargetsList
              stops={filteredFieldTargets}
              isNaRota={(id) => selectedTargetIds.has(id)}
              onToggleRota={toggleTargetId}
              onAbrirDetalhe={setAlvoAberto}
              onRemover={(stop) => removerAlvo(stop.id, stop.customerName)}
            />
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

      <FieldTargetDetailSheet
        stop={alvoAberto}
        detalhe={detalheAberto}
        naRota={alvoAberto ? selectedTargetIds.has(alvoAberto.id) : false}
        onToggleRota={() => alvoAberto && toggleTargetId(alvoAberto.id)}
        onRemover={() => {
          if (alvoAberto) {
            removerAlvo(alvoAberto.id, alvoAberto.customerName);
            setAlvoAberto(null);
          }
        }}
        onOpenChange={(open) => { if (!open) setAlvoAberto(null); }}
      />

    </div>
  );
};

export default AdminRoutePlanner;
