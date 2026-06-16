# Sub-PR 2 — "Achar/filtrar" (Visitas em campo) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No contexto "campo" do Roteirizador, fazer a lista de alvos navegável em volume (Divinópolis = 600+): seletor de UF antes das cidades, filtros (tipo/busca/telefone/status/bairro), lista virtualizada e aviso "1.000 de N" — e trocar a carteira do `ilike` pela RPC `carteira_por_municipio` (fecha o ponto A no frontend e captura a recência pro Sub-PR 4).

**Architecture:** Helpers puros novos em `src/lib/route/` (filtros de alvo, filtro de cidade por UF, mapeamento de linha da carteira) testados em vitest; o hook `useRoutePlanner` passa a chamar a RPC tipada `carteira_por_municipio` e a pedir `p_limit: 1000` nos prospects; componentes finos (`UfSelector`, `AlvosFiltros`, `FieldTargetsList`) sobre os existentes. Nenhuma mudança de banco (a RPC já está em prod do Sub-PR 1). `useFarmerScoring` intocado.

**Tech Stack:** React 18 + TS strict, Supabase RPC tipada, `@tanstack/react-virtual` (novo, leve), shadcn (Input/Select/Switch/Command/Popover), vitest. Tudo pt-BR.

**Spec:** `docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md` (seções 5C, 5D, 6, 9). Decisões travadas: teto `p_limit:1000`/cidade + aviso "1.000 de N"; filtros = helper puro; UF derivada do cache `useRadarCidadesRota.uf` + persistida em localStorage; curadoria/sheet/cores ficam nos Sub-PRs 3-4.

**Invariantes (não-negociáveis):**
- `useFarmerScoring` **intocado** (money-path).
- OpenStreetMap/Nominatim mantidos; geocoding **não** muda neste sub-PR (é o Sub-PR 4) — só o teto/volume.
- A RPC `carteira_por_municipio` é `SECURITY DEFINER` com gate gestor/master; o contexto campo já só abre pra `temAcessoCampo` (master/gestor), então o gate alinha. Em erro (forbidden) o loader degrada pra lista vazia (já tem try/catch).
- Curadoria continua local/sessão; cache de cidades isolado por `user.id` (não regredir).
- Sem migration. Sem Publish automático — o founder publica quando quiser; QA no device fica pendente.

---

## File Structure

**Criar:**
- `src/lib/route/city-filter.ts` — `ufsDe(cidades)`, `filtrarCidadesPorUf(cidades, uf)` (puros).
- `src/lib/route/city-filter.test.ts`
- `src/lib/route/carteira-stop.ts` — `CarteiraRow`, `CarteiraStopDraft`, `carteiraRowToStop(row, cityNome)` (puro; espelha o Returns da RPC).
- `src/lib/route/carteira-stop.test.ts`
- `src/components/reposicao/routePlanner/UfSelector.tsx` — chips de UF (Todos + cada UF).
- `src/components/reposicao/routePlanner/AlvosFiltros.tsx` — tipo + busca + telefone + status + bairro.
- `src/components/reposicao/routePlanner/FieldTargetsList.tsx` — lista virtualizada de `FieldTargetCard`.

**Modificar:**
- `src/lib/route/field-targets.ts` — `FiltrosAlvo`, `FILTROS_ALVO_INICIAL`, `aplicarFiltrosAlvos`, `bairrosDe` (reusa `filtrarAlvos`).
- `src/lib/route/field-targets.test.ts` — testes dos novos + `mk` com override.
- `src/components/reposicao/routePlanner/types.ts` — `+ diasDesdeVisita?: number | null` em `RouteStop`.
- `src/hooks/useRoutePlanner.ts` — `loadCarteiraDaCidade` via RPC; `p_limit:1000`; estado `filtros`; derivados (`bairrosDisponiveis`, `prospectsDisponiveis`); return atualizado.
- `src/components/reposicao/routePlanner/CityMultiSelector.tsx` — embute `UfSelector` + filtra a lista por UF + persiste a UF.
- `src/components/reposicao/routePlanner/FieldTargetsSummary.tsx` — só números + aviso "1.000 de N" (os botões de tipo migram pro `AlvosFiltros`).
- `src/pages/AdminRoutePlanner.tsx` — usa `AlvosFiltros` + `FieldTargetsList`; troca `targetFilter`→`filtros`.
- `package.json` — `@tanstack/react-virtual`.

---

## Task 1: Helpers de filtro de alvos (puro, TDD)

**Files:**
- Modify: `src/lib/route/field-targets.ts`
- Test: `src/lib/route/field-targets.test.ts`

- [ ] **Step 1: Estender o helper `mk` do teste com override**

Em `src/lib/route/field-targets.test.ts`, troque a assinatura do `mk` (linha ~55) para aceitar um terceiro argumento de override:

```typescript
const mk = (
  id: string,
  stopType: RouteStop['stopType'],
  over: Partial<RouteStop> = {},
): RouteStop => ({
  id,
  stopType,
  customerUserId: stopType === 'prospect_visit' ? '' : `u-${id}`,
  customerName: id,
  phone: null,
  address: { street: '', number: '', neighborhood: '', city: '', state: '', zip_code: '' },
  timeSlot: null,
  businessHoursOpen: null,
  businessHoursClose: null,
  status: '',
  visitReason: '',
  priorityScore: 0,
  priorityLabel: 'baixa',
  priorityFactors: [],
  ...over,
});
```

- [ ] **Step 2: Escrever os testes que falham (aplicarFiltrosAlvos + bairrosDe)**

Adicione ao fim de `src/lib/route/field-targets.test.ts`:

```typescript
import {
  FILTROS_ALVO_INICIAL,
  aplicarFiltrosAlvos,
  bairrosDe,
} from './field-targets';

describe('aplicarFiltrosAlvos', () => {
  const stops = [
    mk('ana', 'sales_visit', { customerName: 'Ana Marcenaria', phone: '3399', address: { street: '', number: '', neighborhood: 'Centro', city: '', state: '', zip_code: '' } }),
    mk('beto', 'prospect_visit', { customerName: 'Beto Móveis', phone: null, prospeccaoStatus: 'a_contatar', address: { street: '', number: '', neighborhood: 'Niterói', city: '', state: '', zip_code: '' } }),
    mk('caio', 'prospect_visit', { customerName: 'Caio MDF', phone: '3311', prospeccaoStatus: 'em_conversa', address: { street: '', number: '', neighborhood: 'Centro', city: '', state: '', zip_code: '' } }),
  ];

  it('inicial (todos, sem critérios) → tudo', () => {
    expect(aplicarFiltrosAlvos(stops, FILTROS_ALVO_INICIAL)).toHaveLength(3);
  });
  it('busca por nome é case-insensitive e parcial', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, busca: 'mób' });
    expect(out.map((s) => s.id)).toEqual(['beto']);
  });
  it('comTelefone exclui quem não tem phone', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, comTelefone: true });
    expect(out.map((s) => s.id)).toEqual(['ana', 'caio']);
  });
  it('status (multi) filtra prospects pelo prospeccaoStatus e exclui clientes', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, status: ['em_conversa'] });
    expect(out.map((s) => s.id)).toEqual(['caio']);
  });
  it('bairro exato', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, bairro: 'Centro' });
    expect(out.map((s) => s.id)).toEqual(['ana', 'caio']);
  });
  it('combina tipo + telefone', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, tipo: 'prospects', comTelefone: true });
    expect(out.map((s) => s.id)).toEqual(['caio']);
  });
});

describe('bairrosDe', () => {
  it('únicos, ordenados pt-BR, ignora vazio/whitespace', () => {
    const stops = [
      mk('a', 'sales_visit', { address: { street: '', number: '', neighborhood: 'Niterói', city: '', state: '', zip_code: '' } }),
      mk('b', 'prospect_visit', { address: { street: '', number: '', neighborhood: 'Centro', city: '', state: '', zip_code: '' } }),
      mk('c', 'sales_visit', { address: { street: '', number: '', neighborhood: '  ', city: '', state: '', zip_code: '' } }),
      mk('d', 'sales_visit', { address: { street: '', number: '', neighborhood: 'Centro', city: '', state: '', zip_code: '' } }),
    ];
    expect(bairrosDe(stops)).toEqual(['Centro', 'Niterói']);
  });
  it('lista vazia → vazia', () => {
    expect(bairrosDe([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar o teste e ver falhar**

Run: `heavy bun run test src/lib/route/field-targets.test.ts`
Expected: FAIL — `aplicarFiltrosAlvos`/`bairrosDe`/`FILTROS_ALVO_INICIAL` não exportados (TS2305 / "is not a function").

- [ ] **Step 4: Implementar em `field-targets.ts`**

Adicione ao fim de `src/lib/route/field-targets.ts` (mantém `filtrarAlvos` como está; é reusado):

```typescript
/** Critérios de filtro do universo de alvos (contexto campo). */
export interface FiltrosAlvo {
  /** Tipo: 'todos' | 'clientes' | 'prospects'. */
  tipo: TargetFilter;
  /** Busca por nome (case-insensitive, substring). */
  busca: string;
  /** Só alvos com telefone. */
  comTelefone: boolean;
  /** prospeccao_status incluídos (vazio = todos). Só afeta prospects. */
  status: string[];
  /** Bairro exato (null = todos). */
  bairro: string | null;
}

export const FILTROS_ALVO_INICIAL: FiltrosAlvo = {
  tipo: 'todos',
  busca: '',
  comTelefone: false,
  status: [],
  bairro: null,
};

/** Aplica todos os critérios (AND) sobre o universo de alvos. Puro. */
export function aplicarFiltrosAlvos(stops: RouteStop[], f: FiltrosAlvo): RouteStop[] {
  let out = filtrarAlvos(stops, f.tipo);
  const q = f.busca.trim().toLowerCase();
  if (q) out = out.filter((s) => s.customerName.toLowerCase().includes(q));
  if (f.comTelefone) out = out.filter((s) => !!s.phone && s.phone.trim() !== '');
  if (f.status.length > 0) {
    out = out.filter((s) => s.prospeccaoStatus != null && f.status.includes(s.prospeccaoStatus));
  }
  if (f.bairro != null) {
    out = out.filter((s) => s.address.neighborhood === f.bairro);
  }
  return out;
}

/** Bairros distintos presentes no universo (ordenados pt-BR, sem vazios). Puro. */
export function bairrosDe(stops: RouteStop[]): string[] {
  const set = new Set<string>();
  for (const s of stops) {
    const b = s.address.neighborhood?.trim();
    if (b) set.add(b);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `heavy bun run test src/lib/route/field-targets.test.ts`
Expected: PASS (todos os describes verdes).

- [ ] **Step 6: Commit**

```bash
git add src/lib/route/field-targets.ts src/lib/route/field-targets.test.ts
git commit -m "feat(roteirizador): filtros de alvo (tipo/busca/telefone/status/bairro) — helper puro"
```

---

## Task 2: Filtro de cidade por UF (puro, TDD)

**Files:**
- Create: `src/lib/route/city-filter.ts`
- Test: `src/lib/route/city-filter.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Create `src/lib/route/city-filter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ufsDe, filtrarCidadesPorUf } from './city-filter';
import type { CityOption } from '@/components/reposicao/routePlanner/types';

const mk = (codigo: string, nome: string, uf: string): CityOption => ({
  codigo, nome, uf, total: 0, comTelefone: 0, aContatar: 0,
});

describe('ufsDe', () => {
  it('UFs distintas, ordenadas, uppercase, sem vazios', () => {
    const cidades = [mk('1', 'Divinópolis', 'mg'), mk('2', 'Itaúna', 'MG'), mk('3', 'Bauru', 'SP'), mk('4', 'X', '  ')];
    expect(ufsDe(cidades)).toEqual(['MG', 'SP']);
  });
  it('vazio → vazio', () => {
    expect(ufsDe([])).toEqual([]);
  });
});

describe('filtrarCidadesPorUf', () => {
  const cidades = [mk('1', 'Divinópolis', 'MG'), mk('2', 'Bauru', 'SP')];
  it('uf null → todas', () => {
    expect(filtrarCidadesPorUf(cidades, null)).toHaveLength(2);
  });
  it('filtra pela uf (case-insensitive)', () => {
    expect(filtrarCidadesPorUf(cidades, 'mg').map((c) => c.codigo)).toEqual(['1']);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test src/lib/route/city-filter.test.ts`
Expected: FAIL — módulo `./city-filter` não existe.

- [ ] **Step 3: Implementar**

Create `src/lib/route/city-filter.ts`:

```typescript
// Helpers puros do seletor de cidade do contexto "Visitas em campo".
// Derivam a UF da lista de cidades JÁ cacheada (useRadarCidadesRota.uf) — sem
// ida ao banco. Selecionar UF filtra o CityMultiSelector.
import type { CityOption } from '@/components/reposicao/routePlanner/types';

/** UFs distintas presentes nas cidades (uppercase, ordenadas, sem vazios). */
export function ufsDe(cidades: CityOption[]): string[] {
  const set = new Set<string>();
  for (const c of cidades) {
    const uf = c.uf?.trim().toUpperCase();
    if (uf) set.add(uf);
  }
  return [...set].sort();
}

/** Filtra as cidades pela UF (case-insensitive). uf null/'' → todas. */
export function filtrarCidadesPorUf(cidades: CityOption[], uf: string | null): CityOption[] {
  if (!uf) return cidades;
  const alvo = uf.trim().toUpperCase();
  return cidades.filter((c) => c.uf?.trim().toUpperCase() === alvo);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test src/lib/route/city-filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/route/city-filter.ts src/lib/route/city-filter.test.ts
git commit -m "feat(roteirizador): ufsDe + filtrarCidadesPorUf — seletor de UF (puro)"
```

---

## Task 3: Mapeamento de linha da carteira + campo de recência no tipo (TDD)

**Files:**
- Create: `src/lib/route/carteira-stop.ts`
- Test: `src/lib/route/carteira-stop.test.ts`
- Modify: `src/components/reposicao/routePlanner/types.ts`

- [ ] **Step 1: Adicionar `diasDesdeVisita` ao `RouteStop`**

Em `src/components/reposicao/routePlanner/types.ts`, no bloco "Campos exclusivos de paradas de prospecção" do `RouteStop` (após `prospeccaoStatus?: string;`), acrescente:

```typescript
  // Recência da carteira (RPC carteira_por_municipio); null = nunca visitado.
  // Capturado aqui no Sub-PR 2; consumido pelas cores do mapa no Sub-PR 4.
  diasDesdeVisita?: number | null;
```

- [ ] **Step 2: Escrever o teste que falha**

Create `src/lib/route/carteira-stop.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { carteiraRowToStop, type CarteiraRow } from './carteira-stop';

const row = (over: Partial<CarteiraRow> = {}): CarteiraRow => ({
  user_id: 'u1',
  name: 'Marcenaria Silva',
  phone: '37 99999-0000',
  street: 'Rua A', number: '10', neighborhood: 'Centro',
  city: 'DIVINOPOLIS (MG)', state: 'MG', zip_code: '35500-000', complement: 'Sala 2',
  business_hours_open: '08:00', business_hours_close: '18:00',
  ultima_visita: '2026-06-01T12:00:00Z', dias_desde_visita: 14,
  ...over,
});

describe('carteiraRowToStop', () => {
  it('mapeia os campos e preserva a recência', () => {
    const d = carteiraRowToStop(row(), 'Divinópolis');
    expect(d.id).toBe('carteira-cidade-u1');
    expect(d.customerUserId).toBe('u1');
    expect(d.customerName).toBe('Marcenaria Silva');
    expect(d.phone).toBe('37 99999-0000');
    expect(d.address.complement).toBe('Sala 2');
    expect(d.visitReason).toBe('Cliente em Divinópolis');
    expect(d.businessHoursOpen).toBe('08:00');
    expect(d.diasDesdeVisita).toBe(14);
  });
  it('nunca visitado → diasDesdeVisita null', () => {
    expect(carteiraRowToStop(row({ dias_desde_visita: null, ultima_visita: null }), 'X').diasDesdeVisita).toBeNull();
  });
  it('campos nulos degradam (name→Cliente, phone→null, complement→undefined)', () => {
    const d = carteiraRowToStop(row({ name: null, phone: null, complement: null }), 'X');
    expect(d.customerName).toBe('Cliente');
    expect(d.phone).toBeNull();
    expect(d.address.complement).toBeUndefined();
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `heavy bun run test src/lib/route/carteira-stop.test.ts`
Expected: FAIL — módulo `./carteira-stop` não existe.

- [ ] **Step 4: Implementar**

Create `src/lib/route/carteira-stop.ts`:

```typescript
// Helper puro do Roteirizador-campo (Sub-PR 2): mapeia uma linha da RPC
// carteira_por_municipio para um "draft" de parada (cliente da carteira), sem os
// campos de priority (o client aplica enrichWithPriority). Espelha o Returns da
// RPC (todos os campos podem vir null na prática — o gerador do Supabase não
// marca nullability de RETURNS TABLE). Captura `dias_desde_visita` (recência)
// pro Sub-PR 4 (cores do mapa).

export interface CarteiraRow {
  user_id: string;
  name: string | null;
  phone: string | null;
  street: string | null;
  number: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  complement: string | null;
  business_hours_open: string | null;
  business_hours_close: string | null;
  ultima_visita: string | null;
  dias_desde_visita: number | null;
}

export interface CarteiraStopDraft {
  id: string;
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
  visitReason: string;
  businessHoursOpen: string | null;
  businessHoursClose: string | null;
  diasDesdeVisita: number | null;
}

const s = (v: string | null | undefined): string => (v ?? '').trim();

export function carteiraRowToStop(row: CarteiraRow, cityNome: string): CarteiraStopDraft {
  return {
    id: `carteira-cidade-${row.user_id}`,
    customerUserId: row.user_id,
    customerName: s(row.name) || 'Cliente',
    phone: s(row.phone) || null,
    address: {
      street: s(row.street),
      number: s(row.number),
      neighborhood: s(row.neighborhood),
      city: s(row.city),
      state: s(row.state),
      zip_code: s(row.zip_code),
      complement: s(row.complement) || undefined,
    },
    visitReason: `Cliente em ${cityNome}`,
    businessHoursOpen: s(row.business_hours_open) || null,
    businessHoursClose: s(row.business_hours_close) || null,
    diasDesdeVisita: row.dias_desde_visita,
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `heavy bun run test src/lib/route/carteira-stop.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/route/carteira-stop.ts src/lib/route/carteira-stop.test.ts src/components/reposicao/routePlanner/types.ts
git commit -m "feat(roteirizador): carteiraRowToStop + diasDesdeVisita no RouteStop (puro)"
```

---

## Task 4: Hook — carteira via RPC, teto 1000, estado de filtros

**Files:**
- Modify: `src/hooks/useRoutePlanner.ts`

- [ ] **Step 1: Imports + constante de teto**

Em `src/hooks/useRoutePlanner.ts`, ajuste os imports do `field-targets` e adicione os novos:

Troque o bloco de import de `@/lib/route/field-targets` (linhas ~34-41) por:

```typescript
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
```

(Remova o `filtrarAlvos` do import — passa a ser usado só dentro de `aplicarFiltrosAlvos`.)

Logo após os imports, adicione a constante de teto:

```typescript
// Teto de prospects por cidade pedido à RPC (a RPC capa em 2000 no SQL).
// Divinópolis (600) cabe inteira; metrópole mostra os 1000 mais quentes.
const PROSPECTS_POR_CIDADE = 1000;
```

- [ ] **Step 2: Subir o `p_limit` dos prospects**

Em `loadProspectStops` (linha ~768), troque:

```typescript
            { p_municipio_codigo: city.codigo, p_limit: 50 } as never,
```

por:

```typescript
            { p_municipio_codigo: city.codigo, p_limit: PROSPECTS_POR_CIDADE } as never,
```

- [ ] **Step 3: Trocar `loadCarteiraDaCidade` pela RPC tipada**

Substitua a função `loadCarteiraDaCidade` inteira (linhas ~820-880, do comentário até o `}, []);`) por:

```typescript
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
```

- [ ] **Step 4: Trocar o estado `targetFilter` por `filtros`**

Substitua a declaração de estado da curadoria (linhas ~119-120):

```typescript
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(new Set());
  const [targetFilter, setTargetFilter] = useState<TargetFilter>('todos');
```

por:

```typescript
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(new Set());
  const [filtros, setFiltros] = useState<FiltrosAlvo>(FILTROS_ALVO_INICIAL);
```

E remova `TargetFilter` do import de types (linha ~19) se ficar sem uso (o typecheck do Step 7 acusa; remova então).

- [ ] **Step 5: Derivar `filteredFieldTargets`, `bairrosDisponiveis`, `prospectsDisponiveis`**

Substitua o memo `filteredFieldTargets` (linhas ~1057-1060) por:

```typescript
  const filteredFieldTargets = useMemo(
    () => aplicarFiltrosAlvos(fieldTargets, filtros),
    [fieldTargets, filtros],
  );

  // Bairros presentes no universo (pro Select de filtro).
  const bairrosDisponiveis = useMemo(() => bairrosDe(fieldTargets), [fieldTargets]);

  // Prospects disponíveis no Radar nas cidades (soma do total já cacheado) — base
  // do aviso "1.000 de N" quando o teto trunca a carga.
  const prospectsDisponiveis = useMemo(
    () => selectedCities.reduce((acc, c) => acc + (c.total ?? 0), 0),
    [selectedCities],
  );
```

- [ ] **Step 6: Resetar os filtros ao trocar de cidades**

No effect que reinicia a curadoria (linha ~895), adicione o reset dos filtros junto:

```typescript
  // Trocar as cidades reinicia a curadoria e os filtros (universo novo).
  useEffect(() => {
    setSelectedTargetIds(new Set());
    setFiltros(FILTROS_ALVO_INICIAL);
  }, [selectedCities]);
```

- [ ] **Step 7: Atualizar o `return` do hook**

No objeto de retorno, troque o bloco de curadoria (linhas ~1285-1291) — remova `targetFilter`/`setTargetFilter` e exponha o novo estado + derivados:

```typescript
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
```

- [ ] **Step 8: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS — sem `targetFilter`/`TargetFilter` órfãos; a chamada `supabase.rpc('carteira_por_municipio', …)` tipa (a RPC está nos types gerados). Se acusar `TargetFilter` não usado em `types` import, remova-o do import.

- [ ] **Step 9: Commit**

```bash
git add src/hooks/useRoutePlanner.ts
git commit -m "feat(roteirizador): carteira via RPC carteira_por_municipio + teto prospects 1000 + estado de filtros"
```

---

## Task 5: `UfSelector` + integração no `CityMultiSelector`

**Files:**
- Create: `src/components/reposicao/routePlanner/UfSelector.tsx`
- Modify: `src/components/reposicao/routePlanner/CityMultiSelector.tsx`

- [ ] **Step 1: Criar o `UfSelector`**

Create `src/components/reposicao/routePlanner/UfSelector.tsx`:

```tsx
// Chips de UF do seletor de cidades (Visitas em campo). Deriva as UFs da lista de
// cidades já cacheada (sem ida ao banco). "Todos" + uma por UF; selecionar filtra
// o CityMultiSelector. Touch-friendly (botões), rolável no mobile.
import { Button } from '@/components/ui/button';
import { ufsDe } from '@/lib/route/city-filter';
import type { CityOption } from './types';

export function UfSelector({
  cidades,
  value,
  onChange,
}: {
  cidades: CityOption[];
  value: string | null;
  onChange: (uf: string | null) => void;
}) {
  const ufs = ufsDe(cidades);
  if (ufs.length <= 1) return null; // 1 só UF não precisa de seletor

  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      <span className="text-xs font-medium text-muted-foreground shrink-0 pr-1">Estado:</span>
      <Button
        size="sm"
        variant={value === null ? 'default' : 'outline'}
        className="h-7 text-xs shrink-0"
        onClick={() => onChange(null)}
      >
        Todos
      </Button>
      {ufs.map((uf) => (
        <Button
          key={uf}
          size="sm"
          variant={value === uf ? 'default' : 'outline'}
          className="h-7 text-xs shrink-0 tabular-nums"
          onClick={() => onChange(uf)}
        >
          {uf}
        </Button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Integrar no `CityMultiSelector` (filtra por UF + persiste)**

Em `src/components/reposicao/routePlanner/CityMultiSelector.tsx`:

(a) Ajuste os imports do topo:

```tsx
import { useState, useEffect } from 'react';
import { Check, ChevronsUpDown, MapPin, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useRadarCidadesRota } from '@/queries/useRadarCidadesRota';
import { useAuth } from '@/contexts/AuthContext';
import { filtrarCidadesPorUf } from '@/lib/route/city-filter';
import { UfSelector } from './UfSelector';
import type { CityOption } from './types';
```

(b) No corpo do componente, após `const { data: cidades = [], isLoading } = useRadarCidadesRota();`, adicione o estado de UF com persistência por usuário e a lista filtrada:

```tsx
  const { user } = useAuth();
  const ufKey = user?.id ? `radar-uf-rota:v1:${user.id}` : null;
  const [uf, setUf] = useState<string | null>(() => {
    if (!ufKey || typeof localStorage === 'undefined') return null;
    return localStorage.getItem(ufKey) || null;
  });
  useEffect(() => {
    if (!ufKey || typeof localStorage === 'undefined') return;
    if (uf) localStorage.setItem(ufKey, uf);
    else localStorage.removeItem(ufKey);
  }, [uf, ufKey]);

  const cidadesFiltradas = filtrarCidadesPorUf(cidades, uf);
```

(c) Renderize o `UfSelector` logo abaixo da abertura do container (antes da linha `<div className="flex items-center gap-2">`):

```tsx
  return (
    <div className="space-y-2">
      <UfSelector cidades={cidades} value={uf} onChange={setUf} />
      <div className="flex items-center gap-2">
```

(d) Troque a fonte do `.map` no `CommandGroup` de `cidades` para `cidadesFiltradas`:

```tsx
                  {cidadesFiltradas.map((cidade) => {
```

- [ ] **Step 3: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/reposicao/routePlanner/UfSelector.tsx src/components/reposicao/routePlanner/CityMultiSelector.tsx
git commit -m "feat(roteirizador): seletor de UF antes das cidades (persistido por usuário)"
```

---

## Task 6: `AlvosFiltros` + `FieldTargetsSummary` (números + "1.000 de N") + página

**Files:**
- Create: `src/components/reposicao/routePlanner/AlvosFiltros.tsx`
- Modify: `src/components/reposicao/routePlanner/FieldTargetsSummary.tsx`
- Modify: `src/pages/AdminRoutePlanner.tsx`

- [ ] **Step 1: Criar `AlvosFiltros`**

Create `src/components/reposicao/routePlanner/AlvosFiltros.tsx`:

```tsx
// Controles de filtro do universo de alvos (contexto campo): tipo, busca, "só com
// telefone", status (multi) e bairro. Estado vive no hook (FiltrosAlvo); aqui só
// dispara patches via onChange. Os status são os 3 do Radar (a_contatar /
// contatado_sem_resposta / em_conversa).
import { Search, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { labelProspeccaoStatus } from '@/lib/route/prospect-stop';
import type { FiltrosAlvo } from '@/lib/route/field-targets';
import type { TargetFilter } from './types';

const STATUS_OPCOES = ['a_contatar', 'contatado_sem_resposta', 'em_conversa'] as const;
const TIPO_OPCOES: { key: TargetFilter; label: string }[] = [
  { key: 'todos', label: 'Todos' },
  { key: 'clientes', label: 'Clientes' },
  { key: 'prospects', label: 'Prospects' },
];

const TODOS_BAIRROS = '__todos__';

export function AlvosFiltros({
  filtros,
  onChange,
  bairros,
}: {
  filtros: FiltrosAlvo;
  onChange: (patch: Partial<FiltrosAlvo>) => void;
  bairros: string[];
}) {
  const toggleStatus = (st: string) => {
    const has = filtros.status.includes(st);
    onChange({ status: has ? filtros.status.filter((s) => s !== st) : [...filtros.status, st] });
  };

  return (
    <div className="space-y-2">
      {/* tipo */}
      <div className="flex gap-1">
        {TIPO_OPCOES.map((o) => (
          <Button
            key={o.key}
            size="sm"
            variant={filtros.tipo === o.key ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => onChange({ tipo: o.key })}
          >
            {o.label}
          </Button>
        ))}
      </div>

      {/* busca + telefone */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={filtros.busca}
            onChange={(e) => onChange({ busca: e.target.value })}
            placeholder="Buscar por nome…"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <Button
          size="sm"
          variant={filtros.comTelefone ? 'default' : 'outline'}
          className="h-8 text-xs gap-1 shrink-0"
          onClick={() => onChange({ comTelefone: !filtros.comTelefone })}
          aria-pressed={filtros.comTelefone}
        >
          <Phone className="w-3.5 h-3.5" /> Com telefone
        </Button>
      </div>

      {/* status (multi) + bairro */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {STATUS_OPCOES.map((st) => (
            <Button
              key={st}
              size="sm"
              variant={filtros.status.includes(st) ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => toggleStatus(st)}
              aria-pressed={filtros.status.includes(st)}
            >
              {labelProspeccaoStatus(st)}
            </Button>
          ))}
        </div>
        {bairros.length > 0 && (
          <Select
            value={filtros.bairro ?? TODOS_BAIRROS}
            onValueChange={(v) => onChange({ bairro: v === TODOS_BAIRROS ? null : v })}
          >
            <SelectTrigger className="h-7 w-[160px] text-xs">
              <SelectValue placeholder="Bairro" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS_BAIRROS}>Todos os bairros</SelectItem>
              {bairros.map((b) => (
                <SelectItem key={b} value={b}>{b}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Simplificar `FieldTargetsSummary` (números + "1.000 de N")**

Substitua `src/components/reposicao/routePlanner/FieldTargetsSummary.tsx` inteiro por:

```tsx
// Resumo do universo de alvos do contexto campo: contagens + aviso honesto de
// truncamento ("mostrando X de N prospects"). Os controles de filtro vivem no
// AlvosFiltros. prospectsDisponiveis = soma do total das cidades (radar_contagem).
import { Users, Target, AlertTriangle } from 'lucide-react';

export function FieldTargetsSummary({
  totalClientes,
  totalProspects,
  prospectsDisponiveis,
}: {
  totalClientes: number;
  totalProspects: number;
  prospectsDisponiveis: number;
}) {
  const total = totalClientes + totalProspects;
  // Truncou se carregamos menos prospects do que o Radar tem nas cidades.
  const truncou = prospectsDisponiveis > totalProspects;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-semibold text-foreground">{total} alvos</span>
        <span className="flex items-center gap-1 text-orange-600">
          <Users className="w-3.5 h-3.5" /> {totalClientes} clientes
        </span>
        <span className="flex items-center gap-1 text-yellow-600">
          <Target className="w-3.5 h-3.5" /> {totalProspects} prospects
        </span>
      </div>
      {truncou && (
        <div className="flex items-center gap-2 rounded-md bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Mostrando {totalProspects} de {prospectsDisponiveis} prospects — refine por bairro/filtro.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Ligar na página**

Em `src/pages/AdminRoutePlanner.tsx`:

(a) Adicione o import do `AlvosFiltros` (junto dos demais de `routePlanner`):

```tsx
import { AlvosFiltros } from '@/components/reposicao/routePlanner/AlvosFiltros';
```

(b) No destructuring do `useRoutePlanner()`, localize o bloco de curadoria existente (de `fieldTargets` até `setTargetFilter`, linhas ~89-95) e **substitua o bloco inteiro** por (sem duplicar as chaves que já existiam):

```tsx
    fieldTargets,
    filteredFieldTargets,
    resumoAlvos,
    prospectsDisponiveis,
    bairrosDisponiveis,
    selectedTargetIds,
    toggleTargetId,
    filtros,
    setFiltros,
```

(c) Troque o bloco do `FieldTargetsSummary` no contexto campo (linhas ~220-227) por:

```tsx
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
```

- [ ] **Step 4: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS — `setFiltros` aceita updater; `targetFilter` sumiu de todos os callsites.

- [ ] **Step 5: Commit**

```bash
git add src/components/reposicao/routePlanner/AlvosFiltros.tsx src/components/reposicao/routePlanner/FieldTargetsSummary.tsx src/pages/AdminRoutePlanner.tsx
git commit -m "feat(roteirizador): filtros de alvo na UI (tipo/busca/telefone/status/bairro) + aviso 1000 de N"
```

---

## Task 7: Lista virtualizada de alvos

**Files:**
- Modify: `package.json` (via `bun add`)
- Create: `src/components/reposicao/routePlanner/FieldTargetsList.tsx`
- Modify: `src/pages/AdminRoutePlanner.tsx`

- [ ] **Step 1: Instalar a dependência**

Run: `bun add @tanstack/react-virtual`
Expected: adiciona `@tanstack/react-virtual` em `dependencies` do `package.json` (mesma família do `@tanstack/react-query` já usado).

- [ ] **Step 2: Criar `FieldTargetsList`**

Create `src/components/reposicao/routePlanner/FieldTargetsList.tsx`:

```tsx
// Lista VIRTUALIZADA do universo de alvos (contexto campo). Divinópolis tem 600+
// alvos; renderizar todos os cards de uma vez trava. @tanstack/react-virtual só
// monta as linhas visíveis. Altura estimada ~64px/linha (FieldTargetCard denso).
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FieldTargetCard } from './FieldTargetCard';
import type { RouteStop } from './types';

export function FieldTargetsList({
  stops,
  isNaRota,
  onToggleRota,
}: {
  stops: RouteStop[];
  isNaRota: (id: string) => boolean;
  onToggleRota: (id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: stops.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  return (
    <div ref={parentRef} className="max-h-[60vh] overflow-y-auto rounded-md">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const stop = stops[vi.index];
          return (
            <div
              key={stop.id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
              className="pb-1.5"
            >
              <FieldTargetCard
                stop={stop}
                naRota={isNaRota(stop.id)}
                onToggleRota={() => onToggleRota(stop.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Usar na página**

Em `src/pages/AdminRoutePlanner.tsx`:

(a) Adicione o import:

```tsx
import { FieldTargetsList } from '@/components/reposicao/routePlanner/FieldTargetsList';
```

(b) Substitua o bloco do `.map` de alvos (linhas ~282-291, o `<div className="space-y-1.5"> … </div>`) por:

```tsx
            <FieldTargetsList
              stops={filteredFieldTargets}
              isNaRota={(id) => selectedTargetIds.has(id)}
              onToggleRota={toggleTargetId}
            />
```

- [ ] **Step 4: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS — `useVirtualizer` resolve (dep instalada). `FieldTargetCard` removido do import da página se ficar sem uso direto (deixe se ainda for usado em outro lugar; o typecheck/lint acusa import morto).

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lockb src/components/reposicao/routePlanner/FieldTargetsList.tsx src/pages/AdminRoutePlanner.tsx
git commit -m "feat(roteirizador): lista de alvos virtualizada (@tanstack/react-virtual) — aguenta 600+"
```

---

## Task 8: Verde + PR

**Files:** nenhum (gate de qualidade + integração)

- [ ] **Step 1: Suíte completa + lint + typecheck**

```bash
heavy bun run typecheck > /tmp/sub2-tc.log 2>&1; echo "tc=$?"
heavy bun run test       > /tmp/sub2-test.log 2>&1; echo "test=$?"
bun lint                 > /tmp/sub2-lint.log 2>&1; echo "lint=$?"
```
Expected: `tc=0`, `test=0`, `lint=0`. (NÃO usar `| tail` — o pipe engole o exit code.) Se algum ≠0, ler o log e corrigir antes de seguir.

- [ ] **Step 2: Revisão de diff**

Use a skill `/review` (gstack) sobre o diff da branch — confere SQL safety (N/A aqui), trust boundary, side effects. Corrigir o que apontar.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin claude/roteirizador-campo-subpr2
gh pr create --title "feat(roteirizador): Visitas em campo Sub-PR 2 — UF + filtros + virtualização + carteira via RPC" \
  --body "$(cat <<'EOF'
## O que muda (Sub-PR 2 do redesign "Visitas em campo")

Spec: `docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md`. Pontos A (frontend), C e D.

- **Carteira via RPC** `carteira_por_municipio` (substitui o `ilike` sensível a acento/sufixo "(UF)") — fecha o "zero clientes" no app e captura `dias_desde_visita` (recência) pro Sub-PR 4.
- **Teto de prospects 50 → 1.000/cidade** (a RPC capa em 2.000). Divinópolis (600) cabe inteira.
- **Seletor de UF** antes das cidades (derivado do cache, persistido por usuário).
- **Filtros** de alvo: tipo · busca · só-com-telefone · status (multi) · bairro — helper puro testado.
- **Lista virtualizada** (`@tanstack/react-virtual`) — aguenta 600+ sem travar.
- **Aviso "1.000 de N"** honesto (compara carregados vs total do Radar nas cidades).

`useFarmerScoring` intocado. OSM mantido. Sem migration (a RPC já está em prod do Sub-PR 1).

## Verificação
- `bun run typecheck` ✅ · `bun run test` ✅ · `bun lint` ✅
- Testes puros novos: `aplicarFiltrosAlvos`/`bairrosDe`, `ufsDe`/`filtrarCidadesPorUf`, `carteiraRowToStop`.

## Pendências do founder
- **Publish** do frontend no Lovable (este PR é só código; nada vai a prod sem Publish).
- **QA no device**: seletor de UF, filtros, virtualização da lista, carteira aparecendo (≥1 cliente em Divinópolis).
EOF
)"
```

- [ ] **Step 4: Reportar ao founder**

Renderizar no chat: Sub-PR 2 aberto (link do PR), o que entrega, e as 2 pendências dele (Publish + QA no device). O Sub-PR 3 (detalhe + curar) vem depois.

---

## Self-Review (preencher na execução)

- **Spec coverage:** A-frontend (Task 4) ✓ · C teto (Task 4) + filtros (Tasks 1,6) + virtualização (Task 7) + "1.000 de N" (Task 6) ✓ · D UF (Tasks 2,5) ✓. B/E/F/G ficam nos Sub-PRs 3-4 (fora deste escopo). ✓
- **Type consistency:** `FiltrosAlvo` (campos `tipo/busca/comTelefone/status/bairro`) idêntico entre `field-targets.ts`, hook e `AlvosFiltros`. `CarteiraRow` espelha o Returns da RPC. `diasDesdeVisita` adicionado ao `RouteStop` antes de ser usado no hook. ✓
- **Sem placeholder:** todos os steps têm código/comando completo. ✓
