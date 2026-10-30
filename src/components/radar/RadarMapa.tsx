import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  useRadarContagemMunicipios,
  useRadarPenetracaoMunicipios,
  penetracaoMedia,
  faixaPenetracao,
  formatarPenetracao,
  type FaixaPenetracao,
} from '@/queries/useRadarContagemMunicipios';
import { escapeHtml } from '@/lib/escape-html';
import { track } from '@/lib/analytics';
import type { RadarFiltros } from '@/queries/useRadarLista';

// Fix dos ícones padrão do Leaflet com bundler (mesmo do AdminRoutePlanner).
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

type Camada = 'leads' | 'penetracao';

// Penetração abaixo da média (ou zero com mercado) é a oportunidade: cor de alerta. Sem denominador = neutro.
const COR_FAIXA: Record<FaixaPenetracao, string> = {
  sem_cliente: 'hsl(var(--status-error))',
  abaixo: 'hsl(var(--status-warning))',
  acima: 'hsl(var(--status-success))',
  sem_dado: 'hsl(var(--muted-foreground))',
};

const pino = (r: number, fundo: string, texto: string) =>
  L.divIcon({
    className: 'radar-pin',
    html: `<div style="background:${fundo};color:white;
      width:${r}px;height:${r}px;border-radius:50%;display:flex;align-items:center;justify-content:center;
      font-weight:700;font-size:10px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.3)">${texto}</div>`,
    iconSize: [r, r],
    iconAnchor: [r / 2, r / 2],
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
  const [camada, setCamada] = useState<Camada>('leads');
  const [mostrarConcorrentes, setMostrarConcorrentes] = useState(false);
  const q = useRadarContagemMunicipios(filtros, hojeISO, camada === 'leads');
  const pen = useRadarPenetracaoMunicipios(filtros.uf || null, camada === 'penetracao' || mostrarConcorrentes);
  const media = useMemo(() => penetracaoMedia(pen.data ?? []), [pen.data]);
  // Concorrentes NULL em todas as linhas = o lote vigente ainda não tem a camada publicada (≠ zero revendas).
  const concorrentesSemCarga = !!pen.data && pen.data.length > 0 && pen.data.every((m) => m.concorrentes == null);
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
    const coords: L.LatLngExpression[] = [];

    if (camada === 'leads') {
      const pts = (q.data ?? []).filter((m) => m.lat != null && m.lng != null);
      const max = Math.max(1, ...pts.map((m) => m.total));
      pts.forEach((m) => {
        const r = 10 + Math.round(18 * Math.sqrt(m.total / max));
        coords.push([m.lat as number, m.lng as number]);
        L.marker([m.lat as number, m.lng as number], { icon: pino(r, 'hsl(var(--primary))', String(m.total)) })
          .bindPopup(
            // Leaflet renderiza o popup como HTML cru → escapar dado textual
            // (nome de município/UF) antes de interpolar (defesa-em-profundidade).
            `<strong>${escapeHtml(m.municipio_nome)}/${escapeHtml(m.uf)}</strong><br/>${m.total} empresas · ${m.com_telefone} c/ telefone<br/>${m.a_contatar} a contatar`,
          )
          .on('click', () => onPickRef.current(m.municipio_nome))
          .addTo(layer.current!);
      });
    } else {
      // Tamanho = mercado (empresas do lote vigente); cor = penetração contra a média do conjunto.
      const pts = (pen.data ?? []).filter((m) => m.lat != null && m.lng != null && m.empresas_lote != null);
      const max = Math.max(1, ...pts.map((m) => m.empresas_lote ?? 0));
      pts.forEach((m) => {
        const r = 14 + Math.round(18 * Math.sqrt((m.empresas_lote ?? 0) / max));
        const nome = m.municipio_nome ?? m.municipio_codigo;
        coords.push([m.lat as number, m.lng as number]);
        L.marker([m.lat as number, m.lng as number], {
          icon: pino(r, COR_FAIXA[faixaPenetracao(m, media)], escapeHtml(formatarPenetracao(m.penetracao))),
        })
          .bindPopup(
            `<strong>${escapeHtml(nome)}/${escapeHtml(m.uf)}</strong><br/>` +
              `${m.clientes ?? '—'} clientes de ${m.empresas_lote ?? '—'} empresas do lote (${escapeHtml(formatarPenetracao(m.penetracao))})`,
          )
          .on('click', () => { if (m.municipio_nome) onPickRef.current(m.municipio_nome); })
          .addTo(layer.current!);
      });
    }

    if (mostrarConcorrentes) {
      const conc = (pen.data ?? []).filter((m) => m.lat != null && m.lng != null && (m.concorrentes ?? 0) > 0);
      const maxC = Math.max(1, ...conc.map((m) => m.concorrentes ?? 0));
      conc.forEach((m) => {
        L.circleMarker([m.lat as number, m.lng as number], {
          radius: 6 + Math.round(22 * Math.sqrt((m.concorrentes ?? 0) / maxC)),
          color: 'hsl(var(--status-info))',
          weight: 2,
          fillOpacity: 0.08,
          interactive: true,
        })
          .bindTooltip(`${escapeHtml(m.municipio_nome ?? m.municipio_codigo)}/${escapeHtml(m.uf)}: ${m.concorrentes} revendas de tinta/verniz`)
          .addTo(layer.current!);
      });
    }

    if (coords.length === 0) return;
    map.current.fitBounds(L.latLngBounds(coords), { padding: [30, 30], maxZoom: 9 });
  }, [q.data, pen.data, camada, mostrarConcorrentes, media]);

  const carregando = camada === 'leads' ? q.isLoading : pen.isLoading;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-2 border-b">
        <ToggleGroup
          type="single"
          size="sm"
          value={camada}
          onValueChange={(v) => {
            if (v !== 'leads' && v !== 'penetracao') return;
            setCamada(v);
            track('radar.mapa_camada', { camada: v });
          }}
        >
          <ToggleGroupItem value="leads">Leads</ToggleGroupItem>
          <ToggleGroupItem value="penetracao">Penetração</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <Switch
            id="radar-mapa-concorrentes"
            checked={mostrarConcorrentes}
            onCheckedChange={(ativo) => {
              setMostrarConcorrentes(ativo);
              track('radar.mapa_concorrentes', { ativo });
            }}
          />
          <Label htmlFor="radar-mapa-concorrentes" className="text-xs">Concorrentes (revendas de tinta)</Label>
        </div>
      </div>
      <div ref={mapRef} className="w-full h-[420px]" style={{ zIndex: 1 }} />
      {camada === 'leads' && q.isError && (
        <p className="p-2 text-xs text-status-error">Não foi possível carregar os leads do mapa.</p>
      )}
      {carregando && (
        <div className="p-2">
          <Skeleton className="h-4 w-40" />
        </div>
      )}
      {(camada === 'penetracao' || mostrarConcorrentes) && !pen.isLoading && (
        <div className="p-2 text-xs text-muted-foreground space-y-1">
          {pen.isError && <p className="text-status-error">Não foi possível carregar a penetração.</p>}
          {pen.data === null && <p>Sem lote completo da RFB: penetração e concorrentes indisponíveis até a carga terminar.</p>}
          {camada === 'penetracao' && pen.data && (
            <p>
              Penetração = clientes ÷ empresas do lote vigente{filtros.uf ? ` em ${filtros.uf}` : ''} · média{' '}
              {formatarPenetracao(media)} ·{' '}
              <span style={{ color: COR_FAIXA.sem_cliente }}>●</span> nenhum cliente{' '}
              <span style={{ color: COR_FAIXA.abaixo }}>●</span> abaixo da média{' '}
              <span style={{ color: COR_FAIXA.acima }}>●</span> acima · tamanho = mercado
            </p>
          )}
          {camada === 'penetracao' && pen.data && (
            // Medido em prod (2026-10-29): a fonte do ja_cliente só traz o Omie da Oben (MG); 2.676 dos 2.686
            // clientes do lote estão em MG. Fora dali, 0% pode ser cadastro ausente — o rótulo não pode prometer mais.
            <p>
              Clientes = CNPJs dos perfis do app e do Omie da Oben. Fora de MG quase não há cliente nessa fonte:
              0% ali pode ser cadastro ausente, não mercado virgem.
            </p>
          )}
          {mostrarConcorrentes && concorrentesSemCarga && (
            <p>Concorrentes: a camada ainda não foi carregada para o lote vigente (sem dado, não zero).</p>
          )}
        </div>
      )}
    </Card>
  );
}
