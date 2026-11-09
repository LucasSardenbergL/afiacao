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
  bateuNoTeto,
  LIMITE_MUNICIPIOS,
  type FaixaPenetracao,
} from '@/queries/useRadarContagemMunicipios';
import { escapeHtml } from '@/lib/escape-html';
import { track } from '@/lib/analytics';
import type { RadarFiltros } from '@/queries/useRadarLista';
import { avisoContagem, rotuloRecorteGeo, type CidadeEscolhida } from '@/lib/radar/ui-helpers';
import { popupCidade } from '@/components/radar/popupCidade';

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
  onPick: (cidade: CidadeEscolhida) => void;
}) {
  const [camada, setCamada] = useState<Camada>('leads');
  const [mostrarConcorrentes, setMostrarConcorrentes] = useState(false);
  const q = useRadarContagemMunicipios(filtros, hojeISO, camada === 'leads');
  const pen = useRadarPenetracaoMunicipios(filtros, camada === 'penetracao' || mostrarConcorrentes);
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
        const cidade: CidadeEscolhida = { codigo: m.municipio_codigo, nome: m.municipio_nome, uf: m.uf };
        L.marker([m.lat as number, m.lng as number], { icon: pino(r, 'hsl(var(--primary))', String(m.total)) })
          .bindPopup(popupCidade(
            `${m.municipio_nome}/${m.uf}`,
            [`${m.total} empresas · ${m.com_telefone} c/ telefone`, `${m.a_contatar} a contatar`],
            () => onPickRef.current(cidade),
          ))
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
          .bindPopup(popupCidade(
            `${nome}/${m.uf}`,
            [`${m.clientes ?? '—'} clientes de ${m.empresas_lote ?? '—'} empresas do lote (${formatarPenetracao(m.penetracao)})`],
            () => onPickRef.current({ codigo: m.municipio_codigo, nome: m.municipio_nome, uf: m.uf }),
          ))
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
          <Label htmlFor="radar-mapa-concorrentes" className="text-xs">Revendas de tinta registradas (CNAE)</Label>
        </div>
      </div>
      {/* "Para visitar" filtra a FILA, não o mapa (pacote N): a regra é por lead e não cabe no agregado por município. */}
      {filtros.paraVisitar && camada === 'leads' && (
        <p className="px-2 py-1 text-xs text-muted-foreground border-b" data-testid="radar-mapa-sem-visitar">
          O mapa não aplica o “Para visitar”: os pinos contam todos os leads do recorte.
        </p>
      )}
      <div ref={mapRef} className="w-full h-[420px]" style={{ zIndex: 1 }} />
      {camada === 'leads' && q.isError && (
        <p className="p-2 text-xs text-status-error">{avisoContagem(q.error, 'Leads do mapa')}</p>
      )}
      {camada === 'leads' && q.data && (
        <p className="p-2 text-xs text-muted-foreground" data-testid="radar-mapa-exibidos">
          {q.data.length.toLocaleString('pt-BR')} municípios exibidos {rotuloRecorteGeo(filtros)}
          {bateuNoTeto(q.data.length) && <> (teto de {LIMITE_MUNICIPIOS}: os maiores; há municípios fora do mapa)</>}
          {' '}· toque num pino para ver o resumo e abrir a fila da cidade.
        </p>
      )}
      {carregando && (
        <div className="p-2">
          <Skeleton className="h-4 w-40" />
        </div>
      )}
      {(camada === 'penetracao' || mostrarConcorrentes) && !pen.isLoading && (
        <div className="p-2 text-xs text-muted-foreground space-y-1">
          {pen.isError && <p className="text-status-error">{avisoContagem(pen.error, 'Penetração')}</p>}
          {pen.data === null && <p>Sem lote completo da RFB: penetração e revendas de tinta indisponíveis até a carga terminar.</p>}
          {camada === 'penetracao' && pen.data && (
            <p>
              Penetração = clientes ÷ empresas do lote vigente {rotuloRecorteGeo(filtros)} (o mercado, qualquer situação)
              {bateuNoTeto(pen.data.length) && <>, nos {LIMITE_MUNICIPIOS} maiores mercados</>} · média{' '}
              {formatarPenetracao(media)} ·{' '}
              <span style={{ color: COR_FAIXA.sem_cliente }}>●</span> nenhum cliente{' '}
              <span style={{ color: COR_FAIXA.abaixo }}>●</span> abaixo da média{' '}
              <span style={{ color: COR_FAIXA.acima }}>●</span> acima · tamanho = mercado
            </p>
          )}
          {camada === 'penetracao' && pen.data && (
            // Remedido em 2026-10-31 (docs/historico/radar-mapa-penetracao-e-concorrentes.md): a fonte do ja_cliente
            // cobre as 3 contas Omie (Oben, Colacor, Colacor SC). A carteira segue concentrada em MG; o 0% de SC é real.
            <p>
              Clientes = CNPJs dos perfis do app e dos cadastros Omie das 3 contas (Oben, Colacor e Colacor SC).
              A carteira está concentrada em MG: 0% fora dali é mercado sem cliente do grupo nesta fonte.
            </p>
          )}
          {mostrarConcorrentes && concorrentesSemCarga && (
            <p>Revendas de tinta (CNAE): a camada ainda não foi carregada para o lote vigente (sem dado, não zero).</p>
          )}
        </div>
      )}
    </Card>
  );
}
