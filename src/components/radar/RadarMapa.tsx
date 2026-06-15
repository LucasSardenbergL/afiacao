import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRadarContagemMunicipios } from '@/queries/useRadarContagemMunicipios';
import { escapeHtml } from '@/lib/escape-html';
import type { RadarFiltros } from '@/queries/useRadarLista';

// Fix dos ícones padrão do Leaflet com bundler (mesmo do AdminRoutePlanner).
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

export default function RadarMapa({
  filtros,
  hojeISO,
  onPick,
}: {
  filtros: RadarFiltros;
  hojeISO: string;
  onPick: (municipioNome: string) => void;
}) {
  const q = useRadarContagemMunicipios(filtros, hojeISO, true);
  const mapRef = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  // Mantém a referência mais recente do onPick sem entrar nas deps do effect de
  // marcadores. A página passa onPick inline; sem este ref, um refetch rotineiro
  // da lista (staleTime 30s) re-renderiza → novo onPick → o effect [q.data, onPick]
  // re-roda e o fitBounds dá "snap" de volta no meio do pan do usuário (P2 do review).
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!mapRef.current || map.current) return;
    map.current = L.map(mapRef.current).setView([-15.78, -47.93], 4); // Brasil
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!map.current || !layer.current) return;
    layer.current.clearLayers();
    const pts = (q.data ?? []).filter((m) => m.lat != null && m.lng != null);
    if (pts.length === 0) return;
    const max = Math.max(...pts.map((m) => m.total));
    pts.forEach((m) => {
      const r = 10 + Math.round(18 * Math.sqrt(m.total / Math.max(max, 1)));
      const icon = L.divIcon({
        className: 'radar-pin',
        html: `<div style="background:hsl(var(--primary));color:hsl(var(--primary-foreground));
          width:${r}px;height:${r}px;border-radius:50%;display:flex;align-items:center;justify-content:center;
          font-weight:700;font-size:10px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.3)">${m.total}</div>`,
        iconSize: [r, r],
        iconAnchor: [r / 2, r / 2],
      });
      L.marker([m.lat as number, m.lng as number], { icon })
        .bindPopup(
          // Leaflet renderiza o popup como HTML cru → escapar dado textual
          // (nome de município/UF) antes de interpolar (defesa-em-profundidade).
          `<strong>${escapeHtml(m.municipio_nome)}/${escapeHtml(m.uf)}</strong><br/>${m.total} empresas · ${m.com_telefone} c/ telefone<br/>${m.a_contatar} a contatar`,
        )
        .on('click', () => onPickRef.current(m.municipio_nome))
        .addTo(layer.current!);
    });
    const bounds = L.latLngBounds(
      pts.map((m) => [m.lat as number, m.lng as number] as L.LatLngExpression),
    );
    map.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 9 });
  }, [q.data]);

  return (
    <Card className="overflow-hidden">
      <div ref={mapRef} className="w-full h-[420px]" style={{ zIndex: 1 }} />
      {q.isLoading && (
        <div className="p-2">
          <Skeleton className="h-4 w-40" />
        </div>
      )}
    </Card>
  );
}
