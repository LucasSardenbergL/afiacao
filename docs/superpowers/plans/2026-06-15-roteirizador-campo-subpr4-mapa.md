# Roteirizador-campo Sub-PR 4 — Mapa (cores/formas + legenda + clusters + geocoding progressivo) — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans para implementar task-a-task. Steps usam checkbox (`- [ ]`).

**Goal:** Fechar os pontos **E** (cor=urgência / forma=tipo no mapa, legenda, clusters) e **G** (geocoding progressivo sem spinner) do redesign "Visitas em campo".

**Architecture:** Helpers PUROS em `src/lib/route/` (`markerVisual`, `recenciaFaixa`, `clusterStats`, `ordenarFilaGeocode`) — testáveis sem Leaflet/DOM. O render (`AdminRoutePlanner.tsx`) e o hook (`useRoutePlanner.ts`) consomem os helpers; `markerVisual` devolve **tom semântico** (`success|warning|error|info|neutral`) + **forma** (`circle|diamond`), e só o render mapeia tom→`hsl(var(--status-X))` (adapta a dark). Clusters via `leaflet.markercluster`, **só no contexto campo**. Geocoding vira fila contínua priorizada (marcados→prioridade), com chip discreto em vez do spinner grande.

**Tech Stack:** React 18 + TS strict · Leaflet 1.9 + `leaflet.markercluster` (novo) · vitest · tokens `--status-*` (`src/index.css`).

**Base:** branch `claude/roteirizador-campo-subpr4` ← `origin/main` `796bedd9` (já com Sub-PR 1/2/3, #862 escape-html, #864 telLink removido).

**Spec:** `docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md` (§4 cores travadas, §5E, §5G, §6, §9).

---

## File Structure

- **Create** `src/lib/route/marker-visual.ts` — `MarkerTone`, `MarkerShape`, `markerVisual(stop)`, `recenciaFaixa(dias)`, `clusterStats(stops)`, `TONE_CSS`, `URGENCIA_ORDEM`. Puro.
- **Create** `src/lib/route/marker-visual.test.ts` — todas as faixas/tipos (incl. nunca=cinza, inválido=cinza), limites 30/90, clusterStats.
- **Create** `src/lib/route/geocode-fila.ts` — `EstadoFila`, `ordenarFilaGeocode(stops, estado)`. Puro.
- **Create** `src/lib/route/geocode-fila.test.ts` — exclui sem-rua/resolvidos/falhados/com-coord; marcados primeiro; ordem estável.
- **Create** `src/components/reposicao/routePlanner/MapLegend.tsx` — legenda colapsável (tabela §4).
- **Modify** `package.json` — `+leaflet.markercluster` `+@types/leaflet.markercluster`.
- **Modify** `src/pages/AdminRoutePlanner.tsx` — import CSS markercluster; effect de marcadores usa `markerVisual`+clusters; `MapLegend`; chip de geocoding (remove spinner grande).
- **Modify** `src/hooks/useRoutePlanner.ts` — fila contínua via `ordenarFilaGeocode`; expõe `geocodingPendentes`; remove `geocoding` boolean; reset de falhados ao trocar cidade.

**Invariantes:** `useFarmerScoring` intocado (money-path). Curadoria/geocoding local. Sem banco neste sub-PR (recência já veio do Sub-PR 1). `escapeHtml` dos popups (#862) **preservado**. Cluster **não** usa cor-média (total + borda na maior urgência + badge `!N`).

---

### Task 1: `marker-visual.ts` — cores/formas + clusterStats (puro, TDD)

**Files:** Create `src/lib/route/marker-visual.ts`, `src/lib/route/marker-visual.test.ts`

- [ ] **Step 1: Teste falhando** — `src/lib/route/marker-visual.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { markerVisual, recenciaFaixa, clusterStats, type MarkerTone } from './marker-visual';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

const carteira = (over: Partial<RouteStop> = {}): RouteStop => ({
  id: 'c1', stopType: 'sales_visit', customerUserId: 'u1', customerName: 'X', phone: null,
  address: { street: 'R', number: '1', neighborhood: 'B', city: 'C', state: 'MG', zip_code: '' },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null, status: 'carteira',
  visitReason: '', priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [], ...over,
});
const prospect = (over: Partial<RouteStop> = {}): RouteStop => carteira({
  id: 'p1', stopType: 'prospect_visit', status: 'prospect', prospeccaoStatus: 'a_contatar', ...over,
});

describe('recenciaFaixa', () => {
  it('null → nunca; limites 30/90', () => {
    expect(recenciaFaixa(null)).toBe('nunca');
    expect(recenciaFaixa(undefined)).toBe('nunca');
    expect(recenciaFaixa(0)).toBe('recente');
    expect(recenciaFaixa(30)).toBe('recente');
    expect(recenciaFaixa(31)).toBe('media');
    expect(recenciaFaixa(90)).toBe('media');
    expect(recenciaFaixa(91)).toBe('antiga');
  });
});

describe('markerVisual — carteira (círculo, cor=recência)', () => {
  it('≤30 verde, 31-90 âmbar, >90 vermelho, nunca cinza', () => {
    expect(markerVisual(carteira({ diasDesdeVisita: 10 }))).toEqual({ tone: 'success', shape: 'circle' });
    expect(markerVisual(carteira({ diasDesdeVisita: 60 }))).toEqual({ tone: 'warning', shape: 'circle' });
    expect(markerVisual(carteira({ diasDesdeVisita: 200 }))).toEqual({ tone: 'error', shape: 'circle' });
    expect(markerVisual(carteira({ diasDesdeVisita: null }))).toEqual({ tone: 'neutral', shape: 'circle' });
  });
});

describe('markerVisual — prospect (losango, cor=status)', () => {
  it('a_contatar azul, sem_resposta âmbar, em_conversa vermelho, desconhecido cinza', () => {
    expect(markerVisual(prospect({ prospeccaoStatus: 'a_contatar' }))).toEqual({ tone: 'info', shape: 'diamond' });
    expect(markerVisual(prospect({ prospeccaoStatus: 'contatado_sem_resposta' }))).toEqual({ tone: 'warning', shape: 'diamond' });
    expect(markerVisual(prospect({ prospeccaoStatus: 'em_conversa' }))).toEqual({ tone: 'error', shape: 'diamond' });
    expect(markerVisual(prospect({ prospeccaoStatus: 'xpto' }))).toEqual({ tone: 'neutral', shape: 'diamond' });
    expect(markerVisual(prospect({ prospeccaoStatus: undefined }))).toEqual({ tone: 'neutral', shape: 'diamond' });
  });
});

describe('clusterStats', () => {
  it('conta por tom, maior-urgência p/ borda, nº de vermelhos p/ badge', () => {
    const stops = [
      carteira({ id: 'a', diasDesdeVisita: 5 }),    // success
      carteira({ id: 'b', diasDesdeVisita: 200 }),  // error
      prospect({ id: 'c', prospeccaoStatus: 'em_conversa' }), // error
      prospect({ id: 'd', prospeccaoStatus: 'a_contatar' }),  // info
    ];
    const st = clusterStats(stops);
    expect(st.total).toBe(4);
    expect(st.porTone.error).toBe(2);
    expect(st.porTone.success).toBe(1);
    expect(st.porTone.info).toBe(1);
    expect(st.maiorUrgencia).toBe('error');
    expect(st.vermelhos).toBe(2);
  });
  it('sem vermelhos: maior-urgência cai p/ warning, badge zero', () => {
    const st = clusterStats([carteira({ diasDesdeVisita: 60 }), carteira({ diasDesdeVisita: 5 })]);
    expect(st.maiorUrgencia).toBe('warning');
    expect(st.vermelhos).toBe(0);
  });
});
```

- [ ] **Step 2: Roda → falha** `heavy bun run test src/lib/route/marker-visual.test.ts` (Expected: módulo não existe)

- [ ] **Step 3: Implementa** — `src/lib/route/marker-visual.ts`:

```ts
// Aparência dos pinos do mapa (Sub-PR 4, ponto E). PURO/testável — sem Leaflet/DOM.
// Cor codifica UMA dimensão (urgência de agir); forma codifica o tipo (§4 do design).
// markerVisual devolve só o TOM semântico; o render mapeia tom→hsl(var(--status-X)).
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

export type MarkerTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
export type MarkerShape = 'circle' | 'diamond';
export interface MarkerVisual { tone: MarkerTone; shape: MarkerShape; }

export type RecenciaFaixa = 'recente' | 'media' | 'antiga' | 'nunca';

/** Faixa de recência da carteira. Limites 30/90; null/undefined = nunca visitado. */
export function recenciaFaixa(dias: number | null | undefined): RecenciaFaixa {
  if (dias == null) return 'nunca';
  if (dias <= 30) return 'recente';
  if (dias <= 90) return 'media';
  return 'antiga';
}

const FAIXA_TONE: Record<RecenciaFaixa, MarkerTone> = {
  recente: 'success', media: 'warning', antiga: 'error', nunca: 'neutral',
};

function prospectTone(status: string | null | undefined): MarkerTone {
  switch ((status ?? '').trim()) {
    case 'a_contatar': return 'info';
    case 'contatado_sem_resposta': return 'warning';
    case 'em_conversa': return 'error';
    default: return 'neutral'; // desconhecido/inválido = cinza (§4)
  }
}

/** Tom + forma do pino. Forma = tipo (prospect→losango, carteira→círculo);
 *  tom = urgência (status do prospect / recência da carteira). Para o universo
 *  CAMPO (carteira `sales_visit` + prospect `prospect_visit`). */
export function markerVisual(
  stop: Pick<RouteStop, 'stopType' | 'diasDesdeVisita' | 'prospeccaoStatus'>,
): MarkerVisual {
  if (stop.stopType === 'prospect_visit') {
    return { tone: prospectTone(stop.prospeccaoStatus), shape: 'diamond' };
  }
  return { tone: FAIXA_TONE[recenciaFaixa(stop.diasDesdeVisita)], shape: 'circle' };
}

/** tom→cor CSS (resolve contra os tokens --status-* vivos → adapta a dark). */
export const TONE_CSS: Record<MarkerTone, string> = {
  success: 'hsl(var(--status-success))',
  warning: 'hsl(var(--status-warning))',
  error: 'hsl(var(--status-error))',
  info: 'hsl(var(--status-info))',
  neutral: 'hsl(var(--muted-foreground))',
};

/** Maior→menor urgência (borda do cluster pega o 1º presente). */
export const URGENCIA_ORDEM: MarkerTone[] = ['error', 'warning', 'info', 'success', 'neutral'];

export interface ClusterStats {
  total: number;
  porTone: Record<MarkerTone, number>;
  maiorUrgencia: MarkerTone; // borda do cluster
  vermelhos: number;         // badge !N
}

/** Agrega um cluster SEM cor-média: total, maior-urgência presente, nº de vermelhos. */
export function clusterStats(
  stops: Array<Pick<RouteStop, 'stopType' | 'diasDesdeVisita' | 'prospeccaoStatus'>>,
): ClusterStats {
  const porTone: Record<MarkerTone, number> = { success: 0, warning: 0, error: 0, info: 0, neutral: 0 };
  for (const s of stops) porTone[markerVisual(s).tone]++;
  const maiorUrgencia = URGENCIA_ORDEM.find((t) => porTone[t] > 0) ?? 'neutral';
  return { total: stops.length, porTone, maiorUrgencia, vermelhos: porTone.error };
}
```

- [ ] **Step 4: Roda → passa** `heavy bun run test src/lib/route/marker-visual.test.ts`
- [ ] **Step 5: Commit** `feat(roteirizador): markerVisual + recenciaFaixa + clusterStats — aparência do pino por urgência (puro)`

---

### Task 2: `geocode-fila.ts` — ordenação da fila de geocoding (puro, TDD)

**Files:** Create `src/lib/route/geocode-fila.ts`, `src/lib/route/geocode-fila.test.ts`

- [ ] **Step 1: Teste falhando** — `src/lib/route/geocode-fila.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ordenarFilaGeocode } from './geocode-fila';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

const stop = (id: string, over: Partial<RouteStop> = {}): RouteStop => ({
  id, stopType: 'prospect_visit', customerUserId: '', customerName: id, phone: null,
  address: { street: 'Rua', number: '1', neighborhood: 'B', city: 'C', state: 'MG', zip_code: '' },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null, status: 'prospect',
  visitReason: '', priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [], ...over,
});
const vazio = { resolvidos: new Set<string>(), falhados: new Set<string>(), marcados: new Set<string>() };

describe('ordenarFilaGeocode', () => {
  it('exclui sem-rua, resolvidos, falhados e com-coord', () => {
    const stops = [
      stop('a'),
      stop('semrua', { address: { ...stop('x').address, street: '' } }),
      stop('resolvido'),
      stop('falhou'),
      stop('jaTemCoord', { lat: -20, lng: -44 }),
    ];
    const fila = ordenarFilaGeocode(stops, {
      resolvidos: new Set(['resolvido']), falhados: new Set(['falhou']), marcados: new Set(),
    });
    expect(fila.map((s) => s.id)).toEqual(['a']);
  });
  it('marcados primeiro, mantendo ordem original dentro de cada grupo', () => {
    const stops = [stop('a'), stop('b'), stop('c'), stop('d')];
    const fila = ordenarFilaGeocode(stops, { ...vazio, marcados: new Set(['c']) });
    expect(fila.map((s) => s.id)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('sem marcados → ordem da lista (já vem por prioridade)', () => {
    const stops = [stop('a'), stop('b'), stop('c')];
    expect(ordenarFilaGeocode(stops, vazio).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2: Roda → falha** `heavy bun run test src/lib/route/geocode-fila.test.ts`

- [ ] **Step 3: Implementa** — `src/lib/route/geocode-fila.ts`:

```ts
// Ordenação da fila de geocoding progressivo (Sub-PR 4, ponto G). PURO/testável.
// O worker no useRoutePlanner consome o head a cada ciclo (~1/s) e re-deriva a fila,
// então marcar um alvo no meio do caminho re-prioriza o PRÓXIMO pick (fila contínua).
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

export interface EstadoFila {
  resolvidos: Set<string>; // ids já com coord (cache em memória)
  falhados: Set<string>;   // ids que falharam nesta sessão (não re-tentar → loop termina)
  marcados: Set<string>;   // ids selecionados pra rota (prioridade 1)
}

/** Stops que ainda faltam geocodificar, na ordem de processamento: marcados-na-rota
 *  primeiro, depois a ordem da lista (que já vem por prioridade da RPC). Estável. */
export function ordenarFilaGeocode(stops: RouteStop[], estado: EstadoFila): RouteStop[] {
  const pendentes = stops.filter(
    (s) =>
      !!s.address.street &&
      s.lat == null &&
      !estado.resolvidos.has(s.id) &&
      !estado.falhados.has(s.id),
  );
  return pendentes
    .map((s, i) => ({ s, i, prio: estado.marcados.has(s.id) ? 0 : 1 }))
    .sort((a, b) => a.prio - b.prio || a.i - b.i)
    .map((x) => x.s);
}
```

- [ ] **Step 4: Roda → passa** `heavy bun run test src/lib/route/geocode-fila.test.ts`
- [ ] **Step 5: Commit** `feat(roteirizador): ordenarFilaGeocode — fila contínua priorizada (puro)`

---

### Task 3: Dependência `leaflet.markercluster`

**Files:** Modify `package.json` (via bun add)

- [ ] **Step 1: Instala** (runtime + types):

```bash
bun add leaflet.markercluster && bun add -d @types/leaflet.markercluster
```

- [ ] **Step 2: Verifica** `ls node_modules/leaflet.markercluster/dist/MarkerCluster.css` e `grep markercluster package.json`
- [ ] **Step 3: Commit** `chore(roteirizador): + leaflet.markercluster (clusters do mapa)` — inclui `package.json` + `bun.lockb`

---

### Task 4: `MapLegend` — legenda colapsável

**Files:** Create `src/components/reposicao/routePlanner/MapLegend.tsx`

- [ ] **Step 1: Implementa** — usa `TONE_CSS`/formas, casa com a tabela §4. Colapsável (default fechada em mobile). Sem teste unitário (componente de apresentação puro; cobertura é o build + QA visual):

```tsx
// Legenda do mapa (Sub-PR 4, ponto E): decodifica cor=urgência / forma=tipo.
// Colapsável — não rouba área do mapa no celular.
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { TONE_CSS, type MarkerTone, type MarkerShape } from '@/lib/route/marker-visual';

interface ItemLegenda { tone: MarkerTone; shape: MarkerShape; label: string; }

const ITENS: ItemLegenda[] = [
  { tone: 'success', shape: 'circle', label: 'Cliente — visitado ≤30d' },
  { tone: 'warning', shape: 'circle', label: 'Cliente — 31 a 90d' },
  { tone: 'error', shape: 'circle', label: 'Cliente — >90d' },
  { tone: 'neutral', shape: 'circle', label: 'Cliente — nunca visitado' },
  { tone: 'info', shape: 'diamond', label: 'Prospect — a contatar' },
  { tone: 'warning', shape: 'diamond', label: 'Prospect — sem resposta' },
  { tone: 'error', shape: 'diamond', label: 'Prospect — em conversa' },
];

function Glifo({ tone, shape }: { tone: MarkerTone; shape: MarkerShape }) {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 shrink-0 border border-white shadow-sm"
      style={{
        background: TONE_CSS[tone],
        borderRadius: shape === 'circle' ? '50%' : '2px',
        transform: shape === 'diamond' ? 'rotate(45deg)' : undefined,
      }}
    />
  );
}

export function MapLegend() {
  const [aberta, setAberta] = useState(false);
  return (
    <div className="border-t bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setAberta((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={aberta}
      >
        <span>Legenda do mapa</span>
        {aberta ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {aberta && (
        <ul className="grid grid-cols-1 gap-1.5 px-3 pb-3 sm:grid-cols-2">
          {ITENS.map((it) => (
            <li key={`${it.tone}-${it.shape}-${it.label}`} className="flex items-center gap-2">
              <Glifo tone={it.tone} shape={it.shape} />
              <span className="text-muted-foreground">{it.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck** `heavy bun run typecheck`
- [ ] **Step 3: Commit** `feat(roteirizador): MapLegend — legenda colapsável cor/forma do mapa`

---

### Task 5: Render — `divIcon` por tom/forma + clusters + legenda (campo)

**Files:** Modify `src/pages/AdminRoutePlanner.tsx`

Contexto atual: o effect de marcadores (linhas ~133-191) cria `markersRef.current` (layerGroup) no init; pinta `cor` por `STOP_CONFIG[stopType].markerColor` com override azul `#2563eb` p/ marcados (linha 148); popup já com `escapeHtml` (#862).

- [ ] **Step 1: Imports** — adicionar:

```ts
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { markerVisual, clusterStats, TONE_CSS, type MarkerTone } from '@/lib/route/marker-visual';
import { MapLegend } from '@/components/reposicao/routePlanner/MapLegend';
```

- [ ] **Step 2: Helper local de HTML do pino** (topo do componente ou módulo) — forma+tom, badge numerado p/ marcados, borda dupla p/ `error` (reforço daltonismo):

```ts
type StopMarker = L.Marker & { __stop?: RouteStop };

function divIconAlvo(tone: MarkerTone, shape: 'circle' | 'diamond', numero?: number): L.DivIcon {
  const cor = TONE_CSS[tone];
  const borda = tone === 'error' ? '3px double white' : '2px solid white';
  const raio = shape === 'circle' ? '50%' : '3px';
  const rot = shape === 'diamond' ? 'rotate(45deg)' : 'none';
  // número (posição na rota) fica num filho contra-rotacionado p/ não deitar no losango
  const conteudo = numero != null
    ? `<span style="transform:${shape === 'diamond' ? 'rotate(-45deg)' : 'none'};color:#fff;font-weight:700;font-size:12px">${numero}</span>`
    : '';
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${cor};width:26px;height:26px;border-radius:${raio};transform:${rot};border:${borda};box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center">${conteudo}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}
```

- [ ] **Step 3: init effect** — REMOVER `markersRef.current = L.layerGroup().addTo(...)` (linha ~123). O grupo passa a ser criado no effect de update (cluster no campo / layerGroup no equipe). Manter map+tileLayer+cleanup.

- [ ] **Step 4: effect de marcadores** — substituir a criação de `cor`/`icon`/marker (linhas ~144-180) por:

```ts
// remove o grupo anterior; cria cluster (campo) ou layerGroup (equipe)
markersRef.current?.remove();
const noModoCampo = planningContext === 'campo';
const grupo: L.LayerGroup = noModoCampo
  ? L.markerClusterGroup({
      maxClusterRadius: 48, showCoverageOnHover: false, spiderfyOnMaxZoom: true, chunkedLoading: true,
      iconCreateFunction: (cluster) => {
        const filhos = cluster.getAllChildMarkers() as StopMarker[];
        const st = clusterStats(filhos.map((m) => m.__stop).filter(Boolean) as RouteStop[]);
        const badge = st.vermelhos > 0
          ? `<span style="position:absolute;top:-6px;right:-6px;background:${TONE_CSS.error};color:#fff;border-radius:9px;font-size:10px;font-weight:700;padding:0 5px;border:1px solid #fff">!${st.vermelhos}</span>`
          : '';
        return L.divIcon({
          className: 'custom-cluster',
          html: `<div style="position:relative;width:40px;height:40px;border-radius:50%;background:hsl(var(--background));border:3px solid ${TONE_CSS[st.maiorUrgencia]};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:hsl(var(--foreground));box-shadow:0 2px 8px rgba(0,0,0,.25)">${st.total}${badge}</div>`,
          iconSize: [40, 40], iconAnchor: [20, 20],
        });
      },
    })
  : L.layerGroup();

fonteComCoords.forEach((stop) => {
  const numero = ordemRota.get(stop.id);
  let icon: L.DivIcon;
  if (noModoCampo) {
    const { tone, shape } = markerVisual(stop);
    icon = divIconAlvo(tone, shape, numero); // cor=urgência mesmo marcado; número se na rota
  } else {
    // contexto equipe: comportamento antigo (cor do tipo, círculo numerado)
    const cor = STOP_CONFIG[stop.stopType].markerColor;
    icon = L.divIcon({
      className: 'custom-marker',
      html: `<div style="background:${cor};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">${numero != null ? numero : ''}</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14],
    });
  }
  const hoursLabel = /* ...inalterado, com escapeHtml... */;
  const cfg = STOP_CONFIG[stop.stopType];
  const m = L.marker([stop.lat!, stop.lng!], { icon }) as StopMarker;
  m.__stop = stop; // p/ o clusterStats agregar
  m.bindPopup(/* ...popup com escapeHtml inalterado... */);
  grupo.addLayer(m);
});
grupo.addTo(leafletMap.current);
markersRef.current = grupo;
```

> **Preservar:** todo o bloco do popup com `escapeHtml(...)` (#862) — só muda o ícone e o agrupamento, NÃO o HTML do popup. A linha da rota (polyline) e o `fitBounds` separado ficam intactos.

- [ ] **Step 5: Legenda** — logo após o `<div ref={mapRef} .../>` no Card do mapa, antes do bloco de geocoding: `<MapLegend />`.

- [ ] **Step 6: typecheck + build** `heavy bun run typecheck` ; `heavy bun run build`
- [ ] **Step 7: Commit** `feat(roteirizador): pinos por urgência (cor/forma) + clusters markercluster + legenda (E)`

---

### Task 6: Geocoding progressivo — fila contínua + chip (G)

**Files:** Modify `src/hooks/useRoutePlanner.ts`, `src/pages/AdminRoutePlanner.tsx`

- [ ] **Step 1: Hook — refs e estado** — adicionar perto de `geocodingAbort` (~992):

```ts
const geocodeFalhados = useRef<Set<string>>(new Set());
const selectedIdsRef = useRef<Set<string>>(new Set());
const [geocodingPendentes, setGeocodingPendentes] = useState(0);
```

E um effect curto p/ espelhar a seleção (sem re-disparar o worker): `useEffect(() => { selectedIdsRef.current = selectedTargetIds; }, [selectedTargetIds]);`. Importar `ordenarFilaGeocode` de `@/lib/route/geocode-fila`.

- [ ] **Step 2: Hook — reescrever o worker** (substitui linhas ~1005-1070, o bloco do `.slice(0,15)`):

```ts
// Geocoding progressivo: fila contínua ~1/s, marcados-na-rota primeiro (G).
// Re-deriva a fila a cada ciclo → marcar um alvo re-prioriza o próximo pick.
useEffect(() => {
  geocodingAbort.current?.abort();
  const controller = new AbortController();
  geocodingAbort.current = controller;

  (async () => {
    while (!controller.signal.aborted) {
      const fila = ordenarFilaGeocode(allStops, {
        resolvidos: new Set(geocodedCoords.current.keys()),
        falhados: geocodeFalhados.current,
        marcados: selectedIdsRef.current,
      });
      setGeocodingPendentes(fila.length);
      if (fila.length === 0) break;
      const stop = fila[0];
      try {
        const query = stop.stopType === 'prospect_visit'
          ? buildGeocodeQuery(stop.address)
          : `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}, Brazil`;
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
          { signal: controller.signal },
        );
        const data = await res.json();
        if (data?.[0]) {
          const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
          geocodedCoords.current.set(stop.id, coords);
          setGeocodedAllStops((prev) => prev.map((s) => (s.id === stop.id ? { ...s, lat: coords.lat, lng: coords.lng } : s)));
          if (stop.stopType === 'prospect_visit' && stop.radarCnpj) {
            void supabase.rpc('radar_salvar_geocode' as never, { p_cnpj: stop.radarCnpj, p_lat: coords.lat, p_lng: coords.lng, p_status: 'ok' } as never);
          }
        } else {
          // sem resultado = falha (senão a fila reciclaria o mesmo stop pra sempre)
          geocodeFalhados.current.add(stop.id);
          if (stop.stopType === 'prospect_visit' && stop.radarCnpj) {
            void supabase.rpc('radar_salvar_geocode' as never, { p_cnpj: stop.radarCnpj, p_lat: 0, p_lng: 0, p_status: 'falhou' } as never);
          }
        }
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') break;
        geocodeFalhados.current.add(stop.id);
        if (stop.stopType === 'prospect_visit' && stop.radarCnpj) {
          void supabase.rpc('radar_salvar_geocode' as never, { p_cnpj: stop.radarCnpj, p_lat: 0, p_lng: 0, p_status: 'falhou' } as never);
        }
      }
      if (!controller.signal.aborted) await new Promise((r) => setTimeout(r, 1100));
    }
    if (!controller.signal.aborted) setGeocodingPendentes(0);
  })();

  return () => controller.abort();
}, [allStops]);
```

- [ ] **Step 3: Hook — remover `geocoding` boolean** — apagar `const [geocoding, setGeocoding] = useState(false);` (~79), e trocar no `return` `geocoding,` por `geocodingPendentes,`.

- [ ] **Step 4: Hook — reset ao trocar cidade** — no effect de reset que zera `removidos`/seleção (Sub-PR 3, dispara em `selectedCities`), acrescentar `geocodeFalhados.current.clear();` (permite re-tentar numa nova visita à cidade).

- [ ] **Step 5: Página — chip discreto** — desestruturar `geocodingPendentes` (no lugar de `geocoding`); substituir o bloco do spinner (~288-294) por um chip sobre o mapa:

```tsx
{geocodingPendentes > 0 && (
  <div className="pointer-events-none absolute right-3 top-3 z-[400] flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
    <Loader2 className="h-3 w-3 animate-spin" />
    localizando {geocodingPendentes}…
  </div>
)}
```

> O Card do mapa precisa de `relative` p/ o chip absoluto ancorar (a `<div ref={mapRef}>` fica dentro). Conferir/100% garantir `className="... relative"` no container.

- [ ] **Step 6: Verde** `heavy bun run typecheck` ; `heavy bun run test` ; `heavy bun run build`
- [ ] **Step 7: Commit** `feat(roteirizador): geocoding progressivo — fila contínua + chip discreto, sem spinner (G)`

---

### Task 7: Review + verde + PR

- [ ] **Step 1: Review inline** — reler diff completo (`git diff origin/main`). Checar: `useFarmerScoring` intocado; `escapeHtml` dos popups preservado; nenhum `text-emerald/red` cru; cluster só no campo; chip sem `pointer-events`; sem `.slice(0,15)` remanescente; lint dos arquivos tocados.
- [ ] **Step 2: Gates completos** `heavy bun run typecheck` ; `heavy bun run lint` ; `heavy bun run test` ; `heavy bun run build` ; `bun run claude:size`
- [ ] **Step 3: Knip** `bunx knip` — garantir que `MapLegend`/helpers não ficam órfãos e nenhum import morto.
- [ ] **Step 4: PR** `gh pr create` não-draft (auto-merge arma sozinho). Corpo: o que entrega (E+G), dep nova (`leaflet.markercluster`), simplificações conscientes (re-priorização por viewport = v1.1; marcar-mid-flight re-prioriza o PRÓXIMO pick, não a fila inteira em voo), pendências do founder (Publish + QA no device: cores/formas/clusters/zoom, geocoding sem spinner, chip sumindo ao terminar).
- [ ] **Step 5: Roadmap no chat** — Sub-PR 4 fecha o redesign (1✅ 2✅ 3✅ 4🔄→PR).

---

## Self-Review (writing-plans)

1. **Cobertura do spec:** E (cores §4 → `markerVisual`/`TONE_CSS`; formas; legenda `MapLegend`; clusters sem cor-média `clusterStats`; "na rota" mantém urgência+número — corrige o override azul) ✓ · G (fila contínua substitui `.slice(0,15)`; persiste `radar_salvar_geocode`; chip no lugar do spinner) ✓ · Daltonismo (forma=tipo + borda dupla no error) ✓ · Nunca-visitado=cinza ✓.
2. **Placeholders:** código pronto nos helpers/MapLegend/worker; a integração no render referencia âncoras reais (linhas 123/144-180/288-294). O popup com `escapeHtml` é citado como "inalterado" (preservar literal).
3. **Consistência de tipos:** `MarkerTone`/`MarkerShape`/`ClusterStats`/`EstadoFila` usados igual em helper, teste, MapLegend e render. `markerVisual` aceita `Pick<RouteStop,...>` (serve stop completo). `geocodingPendentes: number` no return e na página.
4. **Desvios conscientes:** (a) re-priorização por viewport/fila-inteira-em-voo = v1.1 (spec §5G/§10); (b) sem teste unitário do worker de I/O (a lógica pura saiu pra `ordenarFilaGeocode`, testada); (c) carteira geocodifica in-memory, sem persistir geo (spec §5G — `addresses` não tem colunas geo).
