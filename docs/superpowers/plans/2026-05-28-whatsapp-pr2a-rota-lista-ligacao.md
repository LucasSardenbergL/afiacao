# PR2a — Fundação de rota + Lista de ligação (phone-free) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o motor de ligação "route-blind" por uma lista de ligação priorizada **pelas cidades da rota do dia seguinte** e pelo **valor econômico** de cada contato, entregando uma tela usável pela vendedora — **sem depender do WhatsApp/360dialog**.

**Architecture:** Helpers puros testados (normalização de cidade com UF, resolver D-1 da rota, gate/score econômico `valor_da_ligacao`, palavra-chave STOP) + 4 tabelas novas no Supabase (agenda de rota, override de feriado, config de disparo, log de contato) aplicadas manualmente via Lovable + um hook `useRouteContactList(date)` que casa `customer_visit_scores` (city-aware) × `customer_metrics_mv` (econômico) × `farmer_client_scores` (churn) e roda o core puro + uma página `/rota/ligacoes` que lista a fila por vendedora. O motor de churn (`useFarmerScoring`) **não é mutado** — vira insumo, reordenado na leitura (mesmo padrão da impersonação).

**Tech Stack:** React 18 + TS + Vite, `@tanstack/react-query`, Supabase (Postgres+RLS), vitest (`bun run test`). Helpers puros co-localizados (`src/lib/whatsapp/*.test.ts`, convenção do PR1).

**Referência de design:** `docs/superpowers/specs/2026-05-28-whatsapp-pr2-rota-disparo-design.md` (§2 rota, §4 normalização, §6 critérios, §8 schema).

> ⚠️ **Critérios §6 são v1 e ficam em funções puras testadas** (`valorDaLigacao`/`buildContactList`) **de propósito**: o passe adversário do codex (spec §6.5, task #23, adiado por RAM) + a calibração do piloto vão ajustar **constantes e estrutura** depois, barato, sem tocar a integração.

---

## File Structure

**Criar:**
- `src/lib/whatsapp/route-city.ts` + `.test.ts` — `CityKey`, `normalizeCityKey`, `cityKeyEquals`.
- `src/lib/whatsapp/route-schedule.ts` + `.test.ts` — utils de data ISO + `resolvePrepForWorkday` (D-1).
- `src/lib/whatsapp/stop-keyword.ts` + `.test.ts` — `isStopKeyword`.
- `src/lib/whatsapp/contact-list.ts` + `.test.ts` — `prontidaoRecompra`, `valorDaLigacao`, `buildContactList` (core §6).
- `supabase/migrations/20260528160000_route_fundacao.sql` — 4 tabelas + RLS + seed (migration manual via Lovable).
- `src/queries/useRouteContactList.ts` — hook React Query (fetch + chama o core puro).
- `src/pages/RotaListaLigacao.tsx` — tela da fila por vendedora.

**Modificar:**
- `src/App.tsx` — rota lazy `/rota/ligacoes`.
- `src/components/AppShell.tsx` — item de nav "Lista de ligação" (gated staff).

---

## Task 1: Normalização de cidade com UF (`route-city.ts`)

**Files:**
- Create: `src/lib/whatsapp/route-city.ts`
- Test: `src/lib/whatsapp/route-city.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/route-city.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeCityKey, cityKeyEquals } from './route-city';

describe('normalizeCityKey', () => {
  it('extrai cidade e UF do formato "FORMIGA (MG)"', () => {
    expect(normalizeCityKey('FORMIGA (MG)')).toEqual({ city: 'FORMIGA', uf: 'MG' });
  });
  it('tira acento e normaliza caixa: "Divinópolis/MG"', () => {
    expect(normalizeCityKey('Divinópolis/MG')).toEqual({ city: 'DIVINOPOLIS', uf: 'MG' });
  });
  it('preserva UF do Tocantins (não vira MG): "Divinópolis (TO)"', () => {
    expect(normalizeCityKey('Divinópolis (TO)')).toEqual({ city: 'DIVINOPOLIS', uf: 'TO' });
  });
  it('cidade sem UF retorna uf vazio: "Pitangui"', () => {
    expect(normalizeCityKey('Pitangui')).toEqual({ city: 'PITANGUI', uf: '' });
  });
  it('aceita UF como sufixo separado por espaço: "Pará de Minas MG"', () => {
    expect(normalizeCityKey('Pará de Minas MG')).toEqual({ city: 'PARA DE MINAS', uf: 'MG' });
  });
  it('retorna null para vazio/lixo', () => {
    expect(normalizeCityKey(null)).toBeNull();
    expect(normalizeCityKey('')).toBeNull();
    expect(normalizeCityKey('   ')).toBeNull();
    expect(normalizeCityKey('(MG)')).toBeNull();
  });
});

describe('cityKeyEquals', () => {
  const formiga = { city: 'FORMIGA', uf: 'MG' };
  it('casa cidade+UF iguais', () => {
    expect(cityKeyEquals(formiga, { city: 'FORMIGA', uf: 'MG' })).toBe(true);
  });
  it('NÃO casa Divinópolis MG x TO (ambos têm UF)', () => {
    expect(cityKeyEquals({ city: 'DIVINOPOLIS', uf: 'MG' }, { city: 'DIVINOPOLIS', uf: 'TO' })).toBe(false);
  });
  it('casa por cidade quando um lado não tem UF (cadastro incompleto)', () => {
    expect(cityKeyEquals(formiga, { city: 'FORMIGA', uf: '' })).toBe(true);
  });
  it('não casa cidades diferentes', () => {
    expect(cityKeyEquals(formiga, { city: 'PIMENTA', uf: 'MG' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/whatsapp/route-city.test.ts`
Expected: FAIL com "normalizeCityKey is not a function" (módulo não existe).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/whatsapp/route-city.ts
export interface CityKey {
  city: string; // canônico: sem acento, UPPER, trim
  uf: string;   // 'MG' | 'TO' | '' (vazio = não informado no cadastro)
}

const UF_RE = /^[A-Z]{2}$/;

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalizeCityKey(raw: string | null | undefined): CityKey | null {
  if (!raw) return null;
  let s = stripAccents(String(raw)).toUpperCase().trim();
  if (!s) return null;

  let uf = '';
  // forma "(MG)" no fim
  const paren = s.match(/\(([A-Z]{2})\)\s*$/);
  if (paren) {
    uf = paren[1];
    s = s.slice(0, paren.index).trim();
  } else {
    // forma "/MG" no fim
    const slash = s.match(/\/\s*([A-Z]{2})\s*$/);
    if (slash) {
      uf = slash[1];
      s = s.slice(0, slash.index).trim();
    } else {
      // forma "... MG" (UF como última palavra)
      const parts = s.split(/\s+/);
      if (parts.length > 1 && UF_RE.test(parts[parts.length - 1])) {
        uf = parts.pop() as string;
        s = parts.join(' ');
      }
    }
  }

  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return { city: s, uf };
}

export function cityKeyEquals(a: CityKey, b: CityKey): boolean {
  if (a.city !== b.city) return false;
  if (a.uf && b.uf) return a.uf === b.uf; // ambos têm UF → tem que bater (desambigua Divinópolis)
  return true; // um lado sem UF → casa por cidade
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/whatsapp/route-city.test.ts`
Expected: PASS (10 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/route-city.ts src/lib/whatsapp/route-city.test.ts
git commit -m "feat(rota): helper de normalização de cidade com UF (anti-Divinópolis/TO)"
```

---

## Task 2: Resolver D-1 da rota (`route-schedule.ts`)

**Files:**
- Create: `src/lib/whatsapp/route-schedule.ts`
- Test: `src/lib/whatsapp/route-schedule.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/route-schedule.test.ts
import { describe, it, expect } from 'vitest';
import { weekdayOfIso, addDaysIso, resolvePrepForWorkday, RouteScheduleRow } from './route-schedule';

// Agenda fixa (spec §2.1). weekday: 0=dom,1=seg,...,6=sab. Terça=2,Qua=3,Qui=4,Sex=5.
const SCHEDULE: RouteScheduleRow[] = [
  { weekday: 2, city: 'FORMIGA', uf: 'MG', is_daily: false, ativo: true },
  { weekday: 2, city: 'PIMENTA', uf: 'MG', is_daily: false, ativo: true },
  { weekday: 3, city: 'CLAUDIO', uf: 'MG', is_daily: false, ativo: true },
  { weekday: 5, city: 'OLIVEIRA', uf: 'MG', is_daily: false, ativo: true },
  { weekday: 0, city: 'DIVINOPOLIS', uf: 'MG', is_daily: true, ativo: true },
  { weekday: 0, city: 'CARMO DO CAJURU', uf: 'MG', is_daily: true, ativo: true },
];

describe('utils de data ISO (UTC, determinístico)', () => {
  it('weekdayOfIso: 2026-05-26 é terça (2)', () => {
    expect(weekdayOfIso('2026-05-26')).toBe(2);
  });
  it('addDaysIso soma dias atravessando mês', () => {
    expect(addDaysIso('2026-05-31', 1)).toBe('2026-06-01');
  });
});

describe('resolvePrepForWorkday (D-1)', () => {
  it('Segunda (2026-05-25) prepara a rota de Terça + diárias', () => {
    const r = resolvePrepForWorkday('2026-05-25', SCHEDULE, []);
    expect(r.dailyOnly).toBe(false);
    expect(r.routeDate).toBe('2026-05-26');
    expect(r.cities.map(c => c.city).sort()).toEqual(
      ['CARMO DO CAJURU', 'DIVINOPOLIS', 'FORMIGA', 'PIMENTA'].sort(),
    );
  });
  it('Sexta (2026-05-29): amanhã é sábado (sem rota) → só diárias', () => {
    const r = resolvePrepForWorkday('2026-05-29', SCHEDULE, []);
    expect(r.dailyOnly).toBe(true);
    expect(r.routeDate).toBeNull();
    expect(r.cities.map(c => c.city).sort()).toEqual(['CARMO DO CAJURU', 'DIVINOPOLIS']);
  });
  it('Quinta (2026-05-28) prepara Sexta', () => {
    const r = resolvePrepForWorkday('2026-05-28', SCHEDULE, []);
    expect(r.routeDate).toBe('2026-05-29');
    expect(r.cities.some(c => c.city === 'OLIVEIRA')).toBe(true);
    expect(r.cities.some(c => c.is_daily)).toBe(true);
  });
  it('feriado na data da rota cancela → cai pra diárias', () => {
    const r = resolvePrepForWorkday('2026-05-25', SCHEDULE, [{ data: '2026-05-26', cancela_rota: true }]);
    expect(r.dailyOnly).toBe(true);
    expect(r.routeDate).toBeNull();
    expect(r.cities.map(c => c.city).sort()).toEqual(['CARMO DO CAJURU', 'DIVINOPOLIS']);
  });
  it('não duplica cidade que é diária E da rota', () => {
    const sched = [...SCHEDULE, { weekday: 2, city: 'DIVINOPOLIS', uf: 'MG', is_daily: false, ativo: true }];
    const r = resolvePrepForWorkday('2026-05-25', sched, []);
    expect(r.cities.filter(c => c.city === 'DIVINOPOLIS').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/whatsapp/route-schedule.test.ts`
Expected: FAIL ("weekdayOfIso is not a function").

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/whatsapp/route-schedule.ts
import { CityKey } from './route-city';

export interface RouteScheduleRow {
  weekday: number;     // 0=dom..6=sab
  city: string;        // canônico (já normalizado, UPPER sem acento)
  uf: string;
  is_daily: boolean;
  ativo: boolean;
}
export interface RouteOverrideRow {
  data: string;        // 'YYYY-MM-DD'
  cancela_rota: boolean;
}
export interface PrepCity extends CityKey {
  is_daily: boolean;
}
export interface PrepResult {
  workday: string;          // hoje 'YYYY-MM-DD'
  routeDate: string | null; // data da rota preparada (D+1 útil) ou null
  cities: PrepCity[];       // alvos do contato de hoje (rota D+1 + diárias), deduplicado
  dailyOnly: boolean;       // true quando não há rota amanhã
}

// UTC determinístico (sem Date.now()/argless new Date()).
export function weekdayOfIso(iso: string): number {
  return new Date(iso + 'T12:00:00Z').getUTCDay();
}
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function resolvePrepForWorkday(
  workdayIso: string,
  schedule: RouteScheduleRow[],
  overrides: RouteOverrideRow[],
): PrepResult {
  const active = schedule.filter(r => r.ativo);
  const daily = active.filter(r => r.is_daily);

  const routeDate = addDaysIso(workdayIso, 1);
  const cancelled = overrides.some(o => o.data === routeDate && o.cancela_rota);
  const routeRows = cancelled ? [] : active.filter(r => !r.is_daily && r.weekday === weekdayOfIso(routeDate));
  const hasRoute = routeRows.length > 0;

  // dedup por city+uf (rota + diárias), diárias entram sempre.
  const seen = new Set<string>();
  const cities: PrepCity[] = [];
  for (const r of [...routeRows, ...daily]) {
    const k = `${r.city}|${r.uf}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cities.push({ city: r.city, uf: r.uf, is_daily: r.is_daily });
  }

  return {
    workday: workdayIso,
    routeDate: hasRoute ? routeDate : null,
    cities,
    dailyOnly: !hasRoute,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/whatsapp/route-schedule.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/route-schedule.ts src/lib/whatsapp/route-schedule.test.ts
git commit -m "feat(rota): resolver D-1 da rota (cidades de amanhã + diárias, feriado-aware)"
```

---

## Task 3: Palavra-chave STOP (`stop-keyword.ts`)

**Files:**
- Create: `src/lib/whatsapp/stop-keyword.ts`
- Test: `src/lib/whatsapp/stop-keyword.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/stop-keyword.test.ts
import { describe, it, expect } from 'vitest';
import { isStopKeyword } from './stop-keyword';

describe('isStopKeyword', () => {
  it.each(['PARAR', 'parar', '  Parar  ', 'SAIR', 'stop', 'Cancelar', 'descadastrar', 'PARAR.'])(
    'reconhece "%s" como opt-out', (s) => expect(isStopKeyword(s)).toBe(true),
  );
  it.each(['quero parar de receber só esse produto', 'oi', '', null, undefined, 'pare na esquina'])(
    'NÃO trata "%s" como opt-out (evita falso-positivo em frase)', (s) => expect(isStopKeyword(s)).toBe(false),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/whatsapp/stop-keyword.test.ts`
Expected: FAIL ("isStopKeyword is not a function").

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/whatsapp/stop-keyword.ts
const STOP = new Set(['PARAR', 'SAIR', 'STOP', 'CANCELAR', 'DESCADASTRAR']);

export function isStopKeyword(body: string | null | undefined): boolean {
  if (!body) return false;
  // só dispara quando a mensagem É a palavra (1 token), não quando aparece numa frase.
  const t = body
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z\s]/g, '').trim();
  return STOP.has(t);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/whatsapp/stop-keyword.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/stop-keyword.ts src/lib/whatsapp/stop-keyword.test.ts
git commit -m "feat(rota): helper isStopKeyword (opt-out só em mensagem de 1 token)"
```

---

## Task 4: Score econômico — prontidão + valor da ligação (`contact-list.ts`)

**Files:**
- Create: `src/lib/whatsapp/contact-list.ts`
- Test: `src/lib/whatsapp/contact-list.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/contact-list.test.ts
import { describe, it, expect } from 'vitest';
import { prontidaoRecompra, valorDaLigacao, ContactCandidate } from './contact-list';

function cand(over: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    customerUserId: 'c1', farmerId: 'f1', cityKey: { city: 'FORMIGA', uf: 'MG' },
    pConverte: 0.5, ticketEsperado: 1000, margemPerc: 0.2,
    diasDesdeUltima: 30, intervaloMedioDias: 30, isColdStart: false,
    optOut: false, contatadoHaDias: null, fechouHoje: false,
    janela24hAberta: false, margemNegativaConhecida: false, ...over,
  };
}

describe('prontidaoRecompra', () => {
  it('no ciclo (ratio ~1) → alta', () => {
    expect(prontidaoRecompra(30, 30)).toBeGreaterThanOrEqual(0.9);
  });
  it('muito antes do ciclo (ratio 0.2) → baixa', () => {
    expect(prontidaoRecompra(6, 30)).toBeLessThanOrEqual(0.3);
  });
  it('atrasado (ratio 1.5) → saturado no topo (1.0)', () => {
    expect(prontidaoRecompra(45, 30)).toBe(1);
  });
  it('sem histórico (null) → neutro 0.5', () => {
    expect(prontidaoRecompra(null, null)).toBe(0.5);
    expect(prontidaoRecompra(10, null)).toBe(0.5);
  });
});

describe('valorDaLigacao', () => {
  it('multiplica P × ticket × margem × prontidão', () => {
    // 0.5 * 1000 * 0.2 * prontidao(30,30)=1.0  → 100
    expect(valorDaLigacao(cand())).toBeCloseTo(100, 5);
  });
  it('cliente fora do ciclo vale menos que no ciclo (mesmos demais)', () => {
    const noCiclo = valorDaLigacao(cand({ diasDesdeUltima: 30, intervaloMedioDias: 30 }));
    const cedo = valorDaLigacao(cand({ diasDesdeUltima: 6, intervaloMedioDias: 30 }));
    expect(cedo).toBeLessThan(noCiclo);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/whatsapp/contact-list.test.ts`
Expected: FAIL ("prontidaoRecompra is not a function").

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/whatsapp/contact-list.ts
import { CityKey } from './route-city';

export interface ContactCandidate {
  customerUserId: string;
  farmerId: string | null;          // dono (vendedora) p/ agrupar a fila
  cityKey: CityKey;
  pConverte: number;                // [0,1] proxy do score (visit/churn normalizado)
  ticketEsperado: number;           // R$ (ticket_medio_90d / fallback de carteira)
  margemPerc: number;               // [0,1]
  diasDesdeUltima: number | null;
  intervaloMedioDias: number | null;
  isColdStart: boolean;
  optOut: boolean;
  contatadoHaDias: number | null;   // dias desde o último contato proativo (route_contact_log)
  fechouHoje: boolean;
  janela24hAberta: boolean;
  margemNegativaConhecida: boolean; // cockpit de valor (v1: false)
}

/** prontidão de recompra ∈ [0,1] a partir de dias/intervalo. v1: linear até o ciclo, satura em 1. */
export function prontidaoRecompra(diasDesdeUltima: number | null, intervaloMedio: number | null): number {
  if (diasDesdeUltima == null || intervaloMedio == null || intervaloMedio <= 0) return 0.5; // neutro
  const ratio = diasDesdeUltima / intervaloMedio;
  if (ratio >= 1) return 1;
  if (ratio <= 0.2) return 0.2;
  // mapeia [0.2,1] → [0.2,1] linear
  return ratio;
}

export function valorDaLigacao(c: ContactCandidate): number {
  const pront = prontidaoRecompra(c.diasDesdeUltima, c.intervaloMedioDias);
  return c.pConverte * c.ticketEsperado * c.margemPerc * pront;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/whatsapp/contact-list.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/contact-list.ts src/lib/whatsapp/contact-list.test.ts
git commit -m "feat(rota): score econômico valor_da_ligacao + prontidão de recompra (puro)"
```

---

## Task 5: Montagem da fila — gates + reservas (`buildContactList`)

**Files:**
- Modify: `src/lib/whatsapp/contact-list.ts` (adiciona tipos + `buildContactList`)
- Test: `src/lib/whatsapp/contact-list.test.ts` (adiciona describe `buildContactList`)

- [ ] **Step 1: Write the failing test (append ao arquivo de teste)**

```ts
// append em src/lib/whatsapp/contact-list.test.ts
import { buildContactList, ContactConfig } from './contact-list';

const CFG: ContactConfig = { winBackReservaPct: 0.2, coldStartPisoDia: 3, capacidadeLigacoes: 10, cadenciaMinDias: 3 };

describe('buildContactList — gates', () => {
  it('exclui opt-out, fechou hoje, valor<=0 e margem negativa', () => {
    const r = buildContactList([
      cand({ customerUserId: 'a', optOut: true }),
      cand({ customerUserId: 'b', fechouHoje: true }),
      cand({ customerUserId: 'c', pConverte: 0 }),         // valor 0
      cand({ customerUserId: 'd', margemNegativaConhecida: true }),
      cand({ customerUserId: 'e' }),                        // sobrevive
    ], CFG);
    const ids = (q: { customerUserId: string }[]) => q.map(x => x.customerUserId).sort();
    expect(ids(r.excluidos)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.excluidos.find(x => x.customerUserId === 'a')!.motivoGate).toBe('opt_out');
    expect(ids([...r.callQueue, ...r.whatsappQueue].filter((x, i, arr) => arr.findIndex(y => y.customerUserId === x.customerUserId) === i)))
      .toContain('e');
  });
  it('exclui por cadência (contatado há menos que o mínimo)', () => {
    const r = buildContactList([cand({ customerUserId: 'x', contatadoHaDias: 1 })], CFG);
    expect(r.excluidos.map(x => x.customerUserId)).toEqual(['x']);
    expect(r.excluidos[0].motivoGate).toBe('cadencia');
  });
  it('exclui JIT prematuro (muito antes do ciclo E baixa propensão)', () => {
    const r = buildContactList([cand({ customerUserId: 'j', diasDesdeUltima: 3, intervaloMedioDias: 30, pConverte: 0.2 })], CFG);
    expect(r.excluidos[0].motivoGate).toBe('jit_prematuro');
  });
});

describe('buildContactList — ordenação, reservas e buckets', () => {
  it('ordena callQueue por valor desc e respeita capacidade', () => {
    const cands = Array.from({ length: 15 }, (_, i) =>
      cand({ customerUserId: `c${i}`, ticketEsperado: 1000 + i * 100 }));
    const r = buildContactList(cands, { ...CFG, capacidadeLigacoes: 5, winBackReservaPct: 0, coldStartPisoDia: 0 });
    expect(r.callQueue.length).toBe(5);
    const vals = r.callQueue.map(c => c.valorDaLigacao);
    expect([...vals].sort((a, b) => b - a)).toEqual(vals); // já ordenado desc
  });
  it('reserva piso de win-back (clientes sumindo) e cold-start mesmo com top forte', () => {
    const tops = Array.from({ length: 20 }, (_, i) =>
      cand({ customerUserId: `top${i}`, ticketEsperado: 5000 }));            // alto valor, no ciclo
    const winbacks = [cand({ customerUserId: 'wb1', diasDesdeUltima: 90, intervaloMedioDias: 30, ticketEsperado: 800 })];
    const colds = [cand({ customerUserId: 'cs1', isColdStart: true, diasDesdeUltima: null, intervaloMedioDias: null })];
    const r = buildContactList([...tops, ...winbacks, ...colds],
      { winBackReservaPct: 0.2, coldStartPisoDia: 1, capacidadeLigacoes: 10, cadenciaMinDias: 3 });
    expect(r.callQueue.find(c => c.customerUserId === 'wb1')?.bucket).toBe('winback');
    expect(r.callQueue.find(c => c.customerUserId === 'cs1')?.bucket).toBe('coldstart');
    expect(r.callQueue.length).toBe(10);
  });
  it('whatsappQueue exclui cold-start, sem-histórico e janela-aberta (vão p/ humano)', () => {
    const r = buildContactList([
      cand({ customerUserId: 'wa-ok' }),
      cand({ customerUserId: 'wa-cold', isColdStart: true }),
      cand({ customerUserId: 'wa-nohist', intervaloMedioDias: null }),
      cand({ customerUserId: 'wa-janela', janela24hAberta: true }),
    ], CFG);
    const ids = r.whatsappQueue.map(x => x.customerUserId);
    expect(ids).toContain('wa-ok');
    expect(ids).not.toContain('wa-cold');
    expect(ids).not.toContain('wa-nohist');
    expect(ids).not.toContain('wa-janela');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/whatsapp/contact-list.test.ts`
Expected: FAIL ("buildContactList is not a function").

- [ ] **Step 3: Write minimal implementation (append em `contact-list.ts`)**

```ts
// append em src/lib/whatsapp/contact-list.ts

export interface ContactConfig {
  winBackReservaPct: number;  // 0.20 → piso de slots p/ win-back
  coldStartPisoDia: number;   // piso de slots p/ novos clientes
  capacidadeLigacoes: number; // quantos cabem no dia (v1: contagem; codex → tempo)
  cadenciaMinDias: number;    // piso absoluto entre contatos proativos
}
export type Bucket = 'top' | 'winback' | 'coldstart';
export interface ScoredCandidate extends ContactCandidate {
  valorDaLigacao: number;
  prontidao: number;
  motivoGate: string | null;     // null = passou
  bucket: Bucket | null;
}
export interface ContactListResult {
  callQueue: ScoredCandidate[];     // ligação (vendedora), ordenada, capada, com reservas
  whatsappQueue: ScoredCandidate[]; // accept-a-proposal (IA)
  excluidos: ScoredCandidate[];     // com motivoGate
}

const LIMIAR_PRONTIDAO_BAIXA = 0.3;
const LIMIAR_P_BAIXA = 0.3;

function score(c: ContactCandidate): ScoredCandidate {
  return { ...c, valorDaLigacao: valorDaLigacao(c), prontidao: prontidaoRecompra(c.diasDesdeUltima, c.intervaloMedioDias), motivoGate: null, bucket: null };
}

function gate(s: ScoredCandidate, cfg: ContactConfig): string | null {
  if (s.optOut) return 'opt_out';
  if (s.fechouHoje) return 'fechou_hoje';
  if (s.margemNegativaConhecida) return 'margem_negativa';
  if (s.valorDaLigacao <= 0) return 'valor_nao_paga';
  if (s.contatadoHaDias != null && s.contatadoHaDias < cfg.cadenciaMinDias) return 'cadencia';
  if (s.prontidao <= LIMIAR_PRONTIDAO_BAIXA && s.pConverte <= LIMIAR_P_BAIXA) return 'jit_prematuro';
  return null;
}

function isWinback(s: ScoredCandidate): boolean {
  if (s.diasDesdeUltima == null || s.intervaloMedioDias == null || s.intervaloMedioDias <= 0) return false;
  return s.diasDesdeUltima / s.intervaloMedioDias >= 1.5; // sumindo/churn
}

export function buildContactList(candidates: ContactCandidate[], cfg: ContactConfig): ContactListResult {
  const scored = candidates.map(score);
  const excluidos: ScoredCandidate[] = [];
  const vivos: ScoredCandidate[] = [];
  for (const s of scored) {
    const m = gate(s, cfg);
    if (m) { excluidos.push({ ...s, motivoGate: m }); } else { vivos.push(s); }
  }
  vivos.sort((a, b) => b.valorDaLigacao - a.valorDaLigacao);

  // --- callQueue com reservas (piso) aplicadas ANTES do corte por capacidade ---
  const cap = Math.max(0, Math.floor(cfg.capacidadeLigacoes));
  const winbackSlots = Math.round(cap * cfg.winBackReservaPct);
  const usados = new Set<string>();
  const pick = (pool: ScoredCandidate[], n: number, bucket: Bucket): ScoredCandidate[] => {
    const out: ScoredCandidate[] = [];
    for (const c of pool) {
      if (out.length >= n) break;
      if (usados.has(c.customerUserId)) continue;
      usados.add(c.customerUserId);
      out.push({ ...c, bucket });
    }
    return out;
  };

  const coldPool = vivos.filter(isColdStartCand);
  const cold = pick(coldPool, Math.min(cfg.coldStartPisoDia, cap), 'coldstart');
  const winbackPool = vivos.filter(isWinback).sort((a, b) =>
    (b.diasDesdeUltima! / b.intervaloMedioDias!) - (a.diasDesdeUltima! / a.intervaloMedioDias!));
  const winback = pick(winbackPool, Math.min(winbackSlots, cap - cold.length), 'winback');
  const top = pick(vivos, cap - cold.length - winback.length, 'top'); // vivos já ordenado por valor

  const callQueue = [...top, ...winback, ...cold]; // top primeiro; reservas garantidas no fim

  // --- whatsappQueue (accept-a-proposal): recompra previsível, fora cold-start/sem-hist/janela aberta ---
  const whatsappQueue = vivos.filter(s => !s.isColdStart && s.intervaloMedioDias != null && !s.janela24hAberta);

  return { callQueue, whatsappQueue, excluidos };
}

function isColdStartCand(s: ScoredCandidate): boolean { return s.isColdStart; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/whatsapp/contact-list.test.ts`
Expected: PASS (todos: 6 do Task 4 + 6 novos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/contact-list.ts src/lib/whatsapp/contact-list.test.ts
git commit -m "feat(rota): buildContactList (gates + reservas win-back/cold-start + filas WA/ligação)"
```

---

## Task 6: Migration das 4 tabelas (manual via Lovable)

**Files:**
- Create: `supabase/migrations/20260528160000_route_fundacao.sql`

> ⚠️ **NÃO é aplicada sozinha.** Entregar o SQL no corpo do PR + inline na conversa pra colar no **SQL Editor do Lovable**. Sem TDD (DDL).

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- supabase/migrations/20260528160000_route_fundacao.sql
-- PR2a: fundação de rota (agenda, override de feriado, config de disparo, log de contato).

CREATE TABLE IF NOT EXISTS public.route_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  city text NOT NULL,            -- canônico: UPPER, sem acento (ex.: 'FORMIGA')
  uf text NOT NULL DEFAULT 'MG',
  is_daily boolean NOT NULL DEFAULT false,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_route_schedule_weekday ON public.route_schedule(weekday) WHERE ativo;

CREATE TABLE IF NOT EXISTS public.route_calendar_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data date NOT NULL UNIQUE,
  cancela_rota boolean NOT NULL DEFAULT false,
  motivo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.route_disparo_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  disparo_inicio time NOT NULL DEFAULT '07:30',
  disparo_corte  time NOT NULL DEFAULT '15:30',
  meta_tier_cap  int  NOT NULL DEFAULT 1000,
  win_back_reserva_pct numeric NOT NULL DEFAULT 0.20,
  cold_start_piso_dia  int NOT NULL DEFAULT 3,
  capacidade_ligacoes_dia int NOT NULL DEFAULT 40,
  cadencia_min_dias int NOT NULL DEFAULT 3,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.route_disparo_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.route_contact_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_rota date NOT NULL,
  customer_user_id uuid,
  farmer_id uuid,
  canal text NOT NULL CHECK (canal IN ('whatsapp','ligacao')),
  valor_da_ligacao numeric,
  bucket text,
  status text,         -- enviado/respondido/convertido/sem_resposta/opt_out
  pedido_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_route_contact_log_customer ON public.route_contact_log(customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_contact_log_data ON public.route_contact_log(data_rota);

ALTER TABLE public.route_schedule          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_calendar_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_disparo_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_contact_log       ENABLE ROW LEVEL SECURITY;

-- leitura: staff (employee/master). escrita: master (config/agenda) — log escrito por service_role (edge, PR2b).
CREATE POLICY "route_sched_staff_read" ON public.route_schedule FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
CREATE POLICY "route_sched_master_write" ON public.route_schedule FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));

CREATE POLICY "route_override_staff_read" ON public.route_calendar_override FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
CREATE POLICY "route_override_master_write" ON public.route_calendar_override FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));

CREATE POLICY "route_config_staff_read" ON public.route_disparo_config FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
CREATE POLICY "route_config_master_write" ON public.route_disparo_config FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));

CREATE POLICY "route_log_staff_read" ON public.route_contact_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

-- seed da agenda fixa (spec §2.1). Cidades canônicas (UPPER, sem acento). VALIDAR grafia no banco antes (spec §13).
INSERT INTO public.route_schedule (weekday, city, uf, is_daily) VALUES
  (2,'FORMIGA','MG',false),(2,'PIMENTA','MG',false),(2,'PIUMHI','MG',false),(2,'CAPITOLIO','MG',false),
  (3,'CLAUDIO','MG',false),(3,'ITAGUARA','MG',false),(3,'ITAUNA','MG',false),(3,'MATEUS LEME','MG',false),(3,'PARA DE MINAS','MG',false),
  (4,'BOM DESPACHO','MG',false),(4,'ABAETE','MG',false),(4,'MARTINHO CAMPOS','MG',false),(4,'PITANGUI','MG',false),(4,'LUZ','MG',false),(4,'NOVA SERRANA','MG',false),(4,'POMPEU','MG',false),
  (5,'SAO JOAO DEL REI','MG',false),(5,'SANTA CRUZ DE MINAS','MG',false),(5,'PRADOS','MG',false),(5,'OLIVEIRA','MG',false),(5,'TIRADENTES','MG',false),(5,'CARMO DA MATA','MG',false),
  (0,'DIVINOPOLIS','MG',true),(0,'CARMO DO CAJURU','MG',true)
ON CONFLICT DO NOTHING;
```

Validação (colar depois):
```sql
SELECT 'ROTA FUNDACAO OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('route_schedule','route_calendar_override','route_disparo_config','route_contact_log')) AS tabelas,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'route_%') AS policies,
  (SELECT count(*) FROM public.route_schedule WHERE ativo) AS cidades_agenda,
  (SELECT count(*) FROM public.route_disparo_config) AS config_linha;
```
Esperado: `tabelas=4`, `policies=7`, `cidades_agenda=24`, `config_linha=1`.

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260528160000_route_fundacao.sql
git commit -m "feat(rota): migration da fundação (route_schedule/override/config/contact_log + RLS + seed)"
```

> Após mergear: regenerar `bun run audit:migrations` e colar o SQL no SQL Editor do Lovable + a validação.

---

## Task 7: Hook `useRouteContactList(date)`

**Files:**
- Create: `src/queries/useRouteContactList.ts`

> Integração (sem TDD unitário — o miolo já é testado em `contact-list.ts`). As tabelas novas não estão no `types.ts` ainda → usar o cast `supabase as unknown as {...}` (padrão `useClientesNaoVinculados`/`useWhatsappInbox`). NÃO usar `any`.

- [ ] **Step 1: Implementar o hook**

```ts
// src/queries/useRouteContactList.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeCityKey, cityKeyEquals } from '@/lib/whatsapp/route-city';
import { resolvePrepForWorkday, RouteScheduleRow, RouteOverrideRow } from '@/lib/whatsapp/route-schedule';
import { buildContactList, ContactCandidate, ContactConfig, ContactListResult } from '@/lib/whatsapp/contact-list';

interface VisitScoreRow {
  customer_user_id: string; farmer_id: string | null; city: string | null; visit_score: number | null;
}
interface MetricRow {
  user_id: string; ticket_medio_90d: number | null; intervalo_medio_dias: number | null;
  dias_desde_ultima_compra: number | null; is_cold_start: boolean | null;
}
interface RouteConfigRow {
  win_back_reserva_pct: number; cold_start_piso_dia: number; capacidade_ligacoes_dia: number; cadencia_min_dias: number;
}

// margem média da empresa (v1 — spec §6.5 q2; calibrar no piloto/codex)
const MARGEM_MEDIA_V1 = 0.22;

export function useRouteContactList(workdayIso: string) {
  return useQuery<ContactListResult & { routeDate: string | null; dailyOnly: boolean; cidades: string[] }>({
    queryKey: ['route-contact-list', workdayIso],
    staleTime: 60_000,
    queryFn: async () => {
      const db = supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> };
            in: (k: string, v: unknown[]) => Promise<{ data: unknown[] | null }>;
            then?: unknown;
          } & Promise<{ data: unknown[] | null }>;
        };
      };

      // 1) agenda + override → cidades D-1
      const [{ data: sched }, { data: ovr }, { data: cfgRow }] = await Promise.all([
        (supabase.from('route_schedule' as never).select('weekday, city, uf, is_daily, ativo')) as unknown as Promise<{ data: RouteScheduleRow[] | null }>,
        (supabase.from('route_calendar_override' as never).select('data, cancela_rota')) as unknown as Promise<{ data: RouteOverrideRow[] | null }>,
        (supabase.from('route_disparo_config' as never).select('win_back_reserva_pct, cold_start_piso_dia, capacidade_ligacoes_dia, cadencia_min_dias').eq('id', true).maybeSingle()) as unknown as Promise<{ data: RouteConfigRow | null }>,
      ]);

      const prep = resolvePrepForWorkday(workdayIso, sched ?? [], ovr ?? []);
      if (prep.cities.length === 0) {
        return { callQueue: [], whatsappQueue: [], excluidos: [], routeDate: prep.routeDate, dailyOnly: prep.dailyOnly, cidades: [] };
      }

      // 2) candidatos por cidade (customer_visit_scores já é city-aware + RLS por carteira)
      const { data: vs } = (await supabase
        .from('customer_visit_scores' as never)
        .select('customer_user_id, farmer_id, city, visit_score')
        .not('city', 'is', null)) as unknown as { data: VisitScoreRow[] | null };

      const cands0 = (vs ?? []).filter(r => {
        const ck = normalizeCityKey(r.city);
        return ck && prep.cities.some(pc => cityKeyEquals(pc, ck));
      });
      if (cands0.length === 0) {
        return { callQueue: [], whatsappQueue: [], excluidos: [], routeDate: prep.routeDate, dailyOnly: prep.dailyOnly, cidades: prep.cities.map(c => c.city) };
      }

      // 3) métricas econômicas em lote
      const userIds = [...new Set(cands0.map(c => c.customer_user_id))];
      const { data: metrics } = (await supabase
        .from('customer_metrics_mv' as never)
        .select('user_id, ticket_medio_90d, intervalo_medio_dias, dias_desde_ultima_compra, is_cold_start')
        .in('user_id', userIds)) as unknown as { data: MetricRow[] | null };
      const mByUser = new Map((metrics ?? []).map(m => [m.user_id, m]));

      const cfg: ContactConfig = {
        winBackReservaPct: cfgRow?.win_back_reserva_pct ?? 0.2,
        coldStartPisoDia: cfgRow?.cold_start_piso_dia ?? 3,
        capacidadeLigacoes: cfgRow?.capacidade_ligacoes_dia ?? 40,
        cadenciaMinDias: cfgRow?.cadencia_min_dias ?? 3,
      };

      const candidates: ContactCandidate[] = cands0.map(r => {
        const m = mByUser.get(r.customer_user_id);
        const ck = normalizeCityKey(r.city)!;
        return {
          customerUserId: r.customer_user_id,
          farmerId: r.farmer_id,
          cityKey: ck,
          pConverte: Math.max(0, Math.min(1, (r.visit_score ?? 0) / 100)),
          ticketEsperado: m?.ticket_medio_90d ?? 0,
          margemPerc: MARGEM_MEDIA_V1,
          diasDesdeUltima: m?.dias_desde_ultima_compra ?? null,
          intervaloMedioDias: m?.intervalo_medio_dias ?? null,
          isColdStart: m?.is_cold_start ?? false,
          optOut: false,            // opt-in entra no PR2b (whatsapp_conversations.opt_in_status)
          contatadoHaDias: null,    // route_contact_log entra no PR2c (métricas/cadência ao vivo)
          fechouHoje: false,
          janela24hAberta: false,
          margemNegativaConhecida: false,
        };
      });

      const result = buildContactList(candidates, cfg);
      return { ...result, routeDate: prep.routeDate, dailyOnly: prep.dailyOnly, cidades: prep.cities.map(c => c.city) };
    },
  });
}
```

- [ ] **Step 2: Verificar typecheck + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json && bun lint`
Expected: sem erro novo (sem `any`, sem `.or()` cru).

- [ ] **Step 3: Commit**

```bash
git add src/queries/useRouteContactList.ts
git commit -m "feat(rota): hook useRouteContactList (cidades D-1 × visit_scores × metrics → fila)"
```

---

## Task 8: Tela `/rota/ligacoes` + rota + nav

**Files:**
- Create: `src/pages/RotaListaLigacao.tsx`
- Modify: `src/App.tsx` (rota lazy)
- Modify: `src/components/AppShell.tsx` (item de nav)

- [ ] **Step 1: Criar a página**

```tsx
// src/pages/RotaListaLigacao.tsx
import { useMemo } from 'react';
import { useRouteContactList } from '@/queries/useRouteContactList';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { CallButton } from '@/components/call/CallButton';
import { PhoneCall } from 'lucide-react';
import type { ScoredCandidate } from '@/lib/whatsapp/contact-list';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const BUCKET_LABEL: Record<string, string> = { top: 'Prioridade', winback: 'Recuperar', coldstart: 'Novo cliente' };

export default function RotaListaLigacao() {
  const workday = useMemo(() => todayIso(), []);
  const { data, isLoading } = useRouteContactList(workday);

  if (isLoading) return <PageSkeleton variant="list" />;
  if (!data || data.callQueue.length === 0) {
    return (
      <div className="p-4">
        <h1 className="font-display text-2xl mb-2">Lista de ligação por rota</h1>
        <EmptyState
          icon={PhoneCall}
          tone="operational"
          title={data?.dailyOnly ? 'Hoje só Divinópolis + Carmo do Cajuru' : 'Nenhum cliente na fila'}
          description={data?.cidades?.length ? `Cidades de amanhã: ${data.cidades.join(', ')}` : 'Sem rota para amanhã.'}
        />
      </div>
    );
  }

  // agrupa por vendedora (farmer_id)
  const byFarmer = new Map<string, ScoredCandidate[]>();
  for (const c of data.callQueue) {
    const k = c.farmerId ?? 'sem_dono';
    (byFarmer.get(k) ?? byFarmer.set(k, []).get(k)!).push(c);
  }

  return (
    <div className="p-4 space-y-4">
      <header>
        <h1 className="font-display text-2xl">Lista de ligação por rota</h1>
        <p className="text-sm text-muted-foreground">
          {data.dailyOnly ? 'Motor diário (Divinópolis + Carmo do Cajuru)' : `Rota de amanhã — ${data.cidades.join(', ')}`}
          {' · '}{data.callQueue.length} ligações priorizadas
        </p>
      </header>

      {[...byFarmer.entries()].map(([farmer, list]) => (
        <Card key={farmer} className="p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Vendedora: {farmer === 'sem_dono' ? '—' : farmer}</div>
          <ol className="space-y-1">
            {list.map((c, i) => (
              <li key={c.customerUserId} className="flex items-center gap-2 py-1 border-b last:border-0">
                <span className="font-mono text-xs w-6 text-muted-foreground">{i + 1}</span>
                <span className="flex-1 font-tabular text-sm">{c.cityKey.city}</span>
                {c.bucket && <Badge variant="secondary">{BUCKET_LABEL[c.bucket]}</Badge>}
                <span className="kpi-value text-sm w-24 text-right">R$ {Math.round(c.valorDaLigacao)}</span>
                <CallButton customerName={c.customerUserId} variant="icon" />
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
```

> ⚠️ Antes de implementar, confirme as props REAIS de `CallButton`, `EmptyState`, `Badge`, `Card`, `PageSkeleton` (ver `src/components/call/CallButton.tsx` etc.). Ajuste o JSX se as assinaturas diferirem (ex.: `CallButton` espera `phone`; nesta v1 não temos o telefone no `customer_visit_scores` → ou buscar `profiles.phone` no hook, ou trocar o `CallButton` por um link de detalhe do cliente). **Decisão de implementação:** se faltar telefone, troque a coluna de ação por `<Link to={\`/admin/customers/${c.customerUserId}\`}>Abrir</Link>` (a ligação acontece no Customer 360 que já tem o `CallButton` device-aware).

- [ ] **Step 2: Registrar a rota lazy em `src/App.tsx`**

Localize o bloco de `lazy(() => import(...))` e adicione:
```tsx
const RotaListaLigacao = lazy(() => import('./pages/RotaListaLigacao'));
```
E dentro das `<Routes>` (junto às rotas staff existentes):
```tsx
<Route path="/rota/ligacoes" element={<RotaListaLigacao />} />
```

- [ ] **Step 3: Adicionar item de nav em `src/components/AppShell.tsx`**

Na seção apropriada (perto de Vendas/Inteligência), adicione ao array de itens:
```tsx
{ icon: PhoneCall, label: 'Lista de ligação', path: '/rota/ligacoes', managerOnly: true },
```
E garanta o import do ícone: `import { PhoneCall } from 'lucide-react';` (se ainda não estiver). O gate `managerOnly`/`isStaff` segue o padrão do item WhatsApp do PR1.

- [ ] **Step 4: Verificar build + typecheck + lint**

Run: `heavy bun run test && heavy bunx tsc --noEmit -p tsconfig.app.json && bun lint && heavy bun build`
Expected: testes 100%, typecheck/lint sem erro novo, build OK.

- [ ] **Step 5: Commit**

```bash
git add src/pages/RotaListaLigacao.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(rota): tela /rota/ligacoes (fila por vendedora) + rota + nav"
```

---

## Self-Review

**1. Spec coverage:**
- §2.1 agenda fixa → Task 6 seed + Task 2 resolver. ✓
- §2.2 D-1 + sexta-só-diárias + feriado → Task 2 (`resolvePrepForWorkday`). ✓
- §4 normalização city+UF (anti-Divinópolis/TO) → Task 1. ✓
- §5 opt-in/STOP → `isStopKeyword` (Task 3) pronto; consumo de opt-in fica no **PR2b** (hook deixa `optOut:false` por ora, comentado). ✓ (parcial por design)
- §6 valor_da_ligacao + gates + reservas + cold-start + win-back → Tasks 4–5. ✓
- §8 schema → Task 6. ✓
- §9 cold-start (novos sempre entram) → Task 5 (`coldStartPisoDia`). ✓
- §10 Div/Cajuru diário → Task 6 seed `is_daily=true` + Task 2 (diárias sempre). ✓
- §3 unificação (não muta churn) → Task 7 (read-time, usa visit_scores/metrics; `farmer_client_scores` fica como sinal futuro). ✓
- **Fora do PR2a (correto):** disparo WhatsApp/templates/ramp (§7) = PR2b; `route_contact_log` métricas/cadência ao vivo (§11) = PR2c. Documentado nos comentários do hook.

**2. Placeholder scan:** sem TBD/TODO; código completo em cada step. A única decisão deixada ao implementador é a prop de telefone do `CallButton` na Task 8 — com **fallback explícito** (link pro Customer 360), não é placeholder vago.

**3. Type consistency:** `CityKey` (Task 1) usada em `route-schedule.ts` (Task 2) e `contact-list.ts` (Task 4). `ContactCandidate`/`ContactConfig`/`ScoredCandidate`/`ContactListResult` (Tasks 4–5) consumidos pelo hook (Task 7) e a página usa `ScoredCandidate` (Task 8). `RouteScheduleRow`/`RouteOverrideRow` (Task 2) usados no hook (Task 7). `resolvePrepForWorkday` retorna `PrepResult` com `cities: PrepCity[]` — consumido no hook. Nomes batem.

**Gaps conscientes (viram PR2b/c, não são do PR2a):** consumo de opt-in real, cadência via `route_contact_log`, janela 24h real, margem por-cliente (hoje `MARGEM_MEDIA_V1`), e o passe do codex §6.5 que vai recalibrar constantes nas funções puras (barato).
