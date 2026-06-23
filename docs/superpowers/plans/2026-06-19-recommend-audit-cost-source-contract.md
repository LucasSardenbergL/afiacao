# Contrato de custo `recommend` + `algorithm-a-audit` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ Atualização 2026-06-23:** o follow-up "convergir `resolverCustoCockpit` → `cost-source.ts` pós-merge #959" está **CANCELADO** — #959 fechado SEM merge, `resolverCustoCockpit` nunca existiu em código, e o split cockpit×recommend é **intencional** (cockpit é source-blind + rebaixa confiança via #1003; ver cabeçalho de `src/lib/custos/cost-source.ts`). Os blocos de código abaixo são **snapshot histórico** de 2026-06-19 (a régua já evoluiu na `main`: +`CMC_MARGEM_ATIPICA`/`CMC_UNIDADE_SUSPEITA`).

**Goal:** Eliminar a fabricação de custo R$0 nos dois edges (`recommend`, `algorithm-a-audit`) — custo ausente vira `null`/indisponível respeitando `cost_source`, sem distorcer ranking nem auditoria.

**Architecture:** Régua de custo confiável num helper puro novo (`src/lib/custos/cost-source.ts`, vitest), espelhada **verbatim** nos edges Deno. `recommend` separa custo de margem (exibido/logado → `null` quando não confiável) de custo de ranking (`estimated_cost_for_ranking`, estimativa rotulada). `algorithm-a-audit` calcula gap/gap% cost-free (já cost-invariante) e níveis absolutos só sob cobertura de custo ≥85% (helper puro `auditoria-margem.ts`). Frontend torna `fmt` null-safe e mostra "—".

**Tech Stack:** TypeScript strict · vitest · Supabase Edge Functions (Deno 2.7) · React 18. Sem migration (colunas `recommendation_log.*` e `margin_audit_log.*` já nullable).

**Spec:** [docs/superpowers/specs/2026-06-19-recommend-audit-cost-source-contract-design.md](../specs/2026-06-19-recommend-audit-cost-source-contract-design.md)

---

### Task 1: Helper puro `cost-source.ts` (régua de custo confiável + estimativa de ranking)

**Files:**
- Create: `src/lib/custos/cost-source.ts`
- Test: `src/lib/custos/__tests__/cost-source.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/custos/__tests__/cost-source.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolverCustoConfiavel, estimarCustoParaRanking, derivarMargensCandidato, type CostRow } from '../cost-source';

const row = (o: Partial<CostRow>): CostRow => ({ cost_price: null, cost_final: null, cost_source: null, cost_confidence: null, ...o });

describe('resolverCustoConfiavel', () => {
  it('PRODUCT_COST com cost_final>0 → cost_final', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: 12.5 }))).toBe(12.5);
  });
  it('CMC com cost_final>0 → cost_final', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 8 }))).toBe(8);
  });
  it('CMC com cost_final=0 mas cost_price>0 → cost_price (os 14 do syncInventory)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 0, cost_price: 9.9 }))).toBe(9.9);
  });
  it('PRODUCT_COST com cost_final inválido NÃO cai p/ cost_price → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: 0, cost_price: 9.9 }))).toBeNull();
  });
  it('FAMILY_MARGIN_PROXY → null (não fabrica margem)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 50 }))).toBeNull();
  });
  it('DEFAULT_PROXY → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'DEFAULT_PROXY', cost_final: 50 }))).toBeNull();
  });
  it('UNKNOWN / source null / row null → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'UNKNOWN', cost_final: 50 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: null, cost_final: 50 }))).toBeNull();
    expect(resolverCustoConfiavel(null)).toBeNull();
    expect(resolverCustoConfiavel(undefined)).toBeNull();
  });
  it('falsificação: cost_final negativo/NaN/Infinity → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: -5 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: NaN }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: Infinity }))).toBeNull();
  });
  it('falsificação CMC: cost_final E cost_price inválidos → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 0, cost_price: 0 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: NaN, cost_price: -1 }))).toBeNull();
  });
  it('normaliza espaço/caixa do backfill', () => {
    expect(resolverCustoConfiavel(row({ cost_source: '  product_cost  ', cost_final: 7 }))).toBe(7);
  });
});

describe('estimarCustoParaRanking', () => {
  it('custo real presente → custo real', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'PRODUCT_COST', cost_final: 30 }), 100)).toBe(30);
  });
  it('sem real, proxy cost_final válido (<price) → proxy cost_final', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 60 }), 100)).toBe(60);
    expect(estimarCustoParaRanking(row({ cost_source: 'DEFAULT_PROXY', cost_final: 75 }), 100)).toBe(75);
  });
  it('proxy cost_final ≥ price (margem estimada ≤0) → null', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'DEFAULT_PROXY', cost_final: 120 }), 100)).toBeNull();
  });
  it('UNKNOWN / sem row / proxy sem cost_final → null', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'UNKNOWN', cost_final: 50 }), 100)).toBeNull();
    expect(estimarCustoParaRanking(null, 100)).toBeNull();
    expect(estimarCustoParaRanking(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: null }), 100)).toBeNull();
  });
});

describe('derivarMargensCandidato', () => {
  it('custo real → exibida e ranking iguais (margem real)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'PRODUCT_COST', cost_final: 30 }), 100))
      .toEqual({ custoConfiavel: 30, custoRanking: 30, margemExibida: 70, margemRanking: 70 });
  });
  it('proxy → exibida null, ranking via estimativa (não fabrica margem exibida)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 60 }), 100))
      .toEqual({ custoConfiavel: null, custoRanking: 60, margemExibida: null, margemRanking: 40 });
  });
  it('UNKNOWN/sem sinal → tudo null (EIP será neutralizado pelo motor)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'UNKNOWN' }), 100))
      .toEqual({ custoConfiavel: null, custoRanking: null, margemExibida: null, margemRanking: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/custos/__tests__/cost-source.test.ts`
Expected: FAIL — "Cannot find module '../cost-source'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/custos/cost-source.ts`:

```ts
// Contrato de custo dos motores de recomendação/auditoria (Codex P2 cost-final-ignorado; follow-up da
// spec do cockpit). Régua IDÊNTICA a resolverCustoCockpit (src/lib/financeiro/valor-cockpit-helpers.ts):
// ausente ≠ R$0; proxy não é custo de margem confiável. Módulo puro — espelhado VERBATIM nas edges Deno
// recommend/index.ts e algorithm-a-audit/index.ts (Deno não importa de src/).
// Resíduo: convergir resolverCustoCockpit → este módulo pós-merge do #959 (fonte única).

export type CostRow = {
  cost_price: number | null;
  cost_final: number | null;
  cost_source: string | null;
  cost_confidence: number | null;
};

const COST_SOURCES_REAIS = new Set(['PRODUCT_COST', 'CMC']);
const COST_SOURCES_PROXY = new Set(['FAMILY_MARGIN_PROXY', 'DEFAULT_PROXY']);

function finitePositive(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

function normalizarSource(source: string | null | undefined): string | null {
  const s = source?.trim().toUpperCase();
  return s ? s : null;
}

// Custo de MARGEM (exibido/logado). Ausente → null (NÃO fabrica margem).
//   1. source∈REAIS e finitePositive(cost_final) → cost_final (vivo, preferido)
//   2. source=CMC e finitePositive(cost_price)   → cost_price (fallback dos 14 do syncInventory)
//   3. resto (PROXY/UNKNOWN/null/fonte nova)      → null
export function resolverCustoConfiavel(row: CostRow | null | undefined): number | null {
  const source = normalizarSource(row?.cost_source);
  if (row == null || source == null || !COST_SOURCES_REAIS.has(source)) return null;
  if (finitePositive(row.cost_final)) return row.cost_final;
  if (source === 'CMC' && finitePositive(row.cost_price)) return row.cost_price;
  return null;
}

// Custo de RANKING (só EIP/score; NUNCA exibido/logado como margem firme). Aceita estimativa proxy
// sanity-bounded (< price → margem estimada positiva). real ?? proxy cost_final válido ?? null.
export function estimarCustoParaRanking(row: CostRow | null | undefined, price: number): number | null {
  const real = resolverCustoConfiavel(row);
  if (real != null) return real;
  const source = normalizarSource(row?.cost_source);
  const cf = row?.cost_final ?? null;
  if (source != null && COST_SOURCES_PROXY.has(source) && finitePositive(cf) && cf < price) return cf;
  return null;
}

export type MargensCandidato = {
  custoConfiavel: number | null;
  custoRanking: number | null;
  margemExibida: number | null;
  margemRanking: number | null;
};

// Split por candidato (recommend). Helper HONESTO (null); o motor aplica o neutro (eip = margemRanking ?? 0).
export function derivarMargensCandidato(row: CostRow | null | undefined, price: number): MargensCandidato {
  const custoConfiavel = resolverCustoConfiavel(row);
  const custoRanking = estimarCustoParaRanking(row, price);
  return {
    custoConfiavel,
    custoRanking,
    margemExibida: custoConfiavel != null ? price - custoConfiavel : null,
    margemRanking: custoRanking != null ? price - custoRanking : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/custos/__tests__/cost-source.test.ts`
Expected: PASS (todos os describes verdes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/custos/cost-source.ts src/lib/custos/__tests__/cost-source.test.ts
git commit -m "feat(custos): resolverCustoConfiavel + estimarCustoParaRanking (régua de custo, vitest)"
```

---

### Task 2: Helper puro `auditoria-margem.ts` (gap cost-free + margens cobertura-gated)

**Files:**
- Create: `src/lib/custos/auditoria-margem.ts`
- Test: `src/lib/custos/__tests__/auditoria-margem.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/custos/__tests__/auditoria-margem.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { calcularAuditoriaMargemCliente, type AuditOrderLine } from '../auditoria-margem';
import type { CostRow } from '../cost-source';

const realRow = (cf: number): CostRow => ({ cost_price: null, cost_final: cf, cost_source: 'PRODUCT_COST', cost_confidence: 0.95 });
const proxyRow = (cf: number): CostRow => ({ cost_price: null, cost_final: cf, cost_source: 'DEFAULT_PROXY', cost_confidence: 0.25 });

// A: actual 80, best 100, qty 2 → leak (100-80)*2 = 40 ; B: actual 50, best 50, qty 1 → leak 0
const orders: AuditOrderLine[] = [
  { product_id: 'A', unit_price: 80, discount: 0, quantity: 2 },
  { product_id: 'B', unit_price: 50, discount: 0, quantity: 1 },
];
const best = (id: string): number | null => (({ A: 100, B: 50 }) as Record<string, number>)[id] ?? null;

describe('calcularAuditoriaMargemCliente — cost-invariância do gap (falsificação)', () => {
  it('margin_gap, top_gap e gap_pct NÃO dependem do custo (cancela); níveis absolutos SIM', () => {
    const c10 = calcularAuditoriaMargemCliente({ orders, custoPorProduto: () => realRow(10), bestPrice: best });
    const c40 = calcularAuditoriaMargemCliente({ orders, custoPorProduto: () => realRow(40), bestPrice: best });
    // cost-invariante:
    expect(c10.margin_gap).toBe(40);
    expect(c40.margin_gap).toBe(40);
    expect(c10.gap_pct).toBe(16);   // 40 / (100*2 + 50*1) * 100
    expect(c40.gap_pct).toBe(16);
    expect(c10.top_gap_products).toEqual([{ product_id: 'A', gap: 40 }]);
    expect(c40.top_gap_products).toEqual([{ product_id: 'A', gap: 40 }]);
    // cost-dependente (níveis absolutos mudam):
    expect(c10.margin_real).toBe(180);      // (80-10)*2 + (50-10)*1
    expect(c40.margin_real).toBe(90);       // (80-40)*2 + (50-40)*1
    expect(c10.margin_potential).toBe(220); // (100-10)*2 + (50-10)*1
  });
});

describe('calcularAuditoriaMargemCliente — gate de cobertura', () => {
  it('cobertura <85% (maioria proxy) → margin_real/potential null, mas gap/gap_pct seguem', () => {
    const mixed: AuditOrderLine[] = [
      { product_id: 'A', unit_price: 80, discount: 0, quantity: 1 },  // real
      { product_id: 'P', unit_price: 90, discount: 0, quantity: 1 },  // proxy → sem custo confiável
    ];
    const cost = (id: string): CostRow => id === 'A' ? realRow(10) : proxyRow(45);
    const bestM = (id: string): number | null => (({ A: 100, P: 100 }) as Record<string, number>)[id] ?? null;
    const r = calcularAuditoriaMargemCliente({ orders: mixed, custoPorProduto: cost, bestPrice: bestM });
    expect(r.margin_real).toBeNull();
    expect(r.margin_potential).toBeNull();
    expect(r.margin_gap).toBe(30);               // leak A (100-80)*1=20 + P (100-90)*1=10
    expect(r.gap_pct).toBe(15);                  // 30 / (100+100) * 100
    expect(r.cobertura_custo).toBeCloseTo(80 / 170, 5); // receitaComCusto 80 / receita 170
  });

  it('cobertura ≥85% → níveis presentes', () => {
    const r = calcularAuditoriaMargemCliente({ orders, custoPorProduto: () => realRow(10), bestPrice: best });
    expect(r.cobertura_custo).toBe(1);
    expect(r.margin_real).toBe(180);
  });
});

describe('calcularAuditoriaMargemCliente — degenerados', () => {
  it('sem linha válida (product_id null) → gap 0, gap_pct null, margins null', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: null, unit_price: 1, discount: 0, quantity: 1 }],
      custoPorProduto: () => null,
      bestPrice: () => null,
    });
    expect(r.margin_gap).toBe(0);
    expect(r.gap_pct).toBeNull();
    expect(r.margin_real).toBeNull();
  });
  it('sem best price → bestPrice = actualPrice → leak 0', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: 'X', unit_price: 70, discount: 0, quantity: 1 }],
      custoPorProduto: () => realRow(20),
      bestPrice: () => null,
    });
    expect(r.margin_gap).toBe(0);
    expect(r.gap_pct).toBe(0);
    expect(r.margin_real).toBe(50); // (70-20)*1
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/custos/__tests__/auditoria-margem.test.ts`
Expected: FAIL — "Cannot find module '../auditoria-margem'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/custos/auditoria-margem.ts`:

```ts
// Auditoria de margem (Algorithm A — margin_audit_log). Núcleo puro espelhado VERBATIM na edge
// algorithm-a-audit/index.ts. Custo ausente ≠ R$0 (resolverCustoConfiavel). margin_gap e
// top_gap_products são COST-INVARIANTES ((bestPrice−cost)−(actualPrice−cost)=bestPrice−actualPrice);
// gap_pct = vazamento-de-receita % (cost-free). Níveis absolutos margin_real/potential só sob
// cobertura de custo ≥0.85 (espelha o gate do cockpit); senão null (ausente ≠ fabricar).

import { resolverCustoConfiavel, type CostRow } from './cost-source';

export type AuditOrderLine = {
  product_id: string | null;
  unit_price: number | null;
  discount: number | null;
  quantity: number | null;
};

export type AuditoriaCliente = {
  margin_real: number | null;
  margin_potential: number | null;
  margin_gap: number;
  gap_pct: number | null;
  top_gap_products: { product_id: string; gap: number }[];
  cobertura_custo: number;
};

const COBERTURA_CUSTO_MIN = 0.85;
const round2 = (x: number) => Math.round(x * 100) / 100;

export function calcularAuditoriaMargemCliente(input: {
  orders: AuditOrderLine[];
  custoPorProduto: (productId: string) => CostRow | null | undefined;
  bestPrice: (productId: string) => number | null | undefined;
}): AuditoriaCliente {
  let marginGap = 0;
  let bestRevenue = 0;
  let receita = 0;
  let marginRealKnown = 0;
  let marginPotentialKnown = 0;
  let receitaComCusto = 0;
  const topGap: { product_id: string; gap: number }[] = [];

  for (const o of input.orders) {
    if (!o.product_id) continue;
    const qty = Number(o.quantity);
    const up = Number(o.unit_price);
    if (!Number.isFinite(qty) || !Number.isFinite(up)) continue;
    const actualPrice = up * (1 - Number(o.discount || 0) / 100);
    const bp = input.bestPrice(o.product_id);
    const bestPrice = typeof bp === 'number' && Number.isFinite(bp) ? bp : actualPrice;

    // cost-free (sempre): vazamento de preço
    const leak = (bestPrice - actualPrice) * qty;
    marginGap += leak;
    bestRevenue += bestPrice * qty;
    receita += actualPrice * qty;
    if (leak > 0) topGap.push({ product_id: o.product_id, gap: leak });

    // níveis absolutos: só com custo REAL (proxy/UNKNOWN/null não conta)
    const custo = resolverCustoConfiavel(input.custoPorProduto(o.product_id));
    if (custo != null) {
      marginRealKnown += (actualPrice - custo) * qty;
      marginPotentialKnown += (bestPrice - custo) * qty;
      receitaComCusto += actualPrice * qty;
    }
  }

  topGap.sort((a, b) => b.gap - a.gap);
  const cobertura_custo = receita > 0 ? receitaComCusto / receita : 0;
  const temCobertura = cobertura_custo >= COBERTURA_CUSTO_MIN;

  return {
    margin_real: temCobertura ? round2(marginRealKnown) : null,
    margin_potential: temCobertura ? round2(marginPotentialKnown) : null,
    margin_gap: round2(marginGap),
    gap_pct: bestRevenue > 0 ? round2((marginGap / bestRevenue) * 100) : null,
    top_gap_products: topGap.slice(0, 5),
    cobertura_custo,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/custos/__tests__/auditoria-margem.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/custos/auditoria-margem.ts src/lib/custos/__tests__/auditoria-margem.test.ts
git commit -m "feat(custos): calcularAuditoriaMargemCliente — gap cost-free + margens cobertura-gated (vitest)"
```

---

### Task 3: `recommend` edge — espelhar helper + split ranking/exibição

**Files:**
- Modify: `supabase/functions/recommend/index.ts`

> Deno não importa de `src/` → as 3 funções + tipos de `cost-source.ts` são coladas **verbatim** no topo do edge.

- [ ] **Step 1: Colar o bloco-espelho do helper**

Em `supabase/functions/recommend/index.ts`, logo após a função `minMaxNorm` (linha ~27, antes de `// ======== RECOMMENDATION ENGINE ========`), inserir:

```ts
// ======== COST CONTRACT (espelho VERBATIM de src/lib/custos/cost-source.ts — manter idêntico) ========
type CostRow = { cost_price: number | null; cost_final: number | null; cost_source: string | null; cost_confidence: number | null };
const COST_SOURCES_REAIS = new Set(["PRODUCT_COST", "CMC"]);
const COST_SOURCES_PROXY = new Set(["FAMILY_MARGIN_PROXY", "DEFAULT_PROXY"]);
function finitePositive(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}
function normalizarSource(source: string | null | undefined): string | null {
  const s = source?.trim().toUpperCase();
  return s ? s : null;
}
function resolverCustoConfiavel(row: CostRow | null | undefined): number | null {
  const source = normalizarSource(row?.cost_source);
  if (row == null || source == null || !COST_SOURCES_REAIS.has(source)) return null;
  if (finitePositive(row.cost_final)) return row.cost_final;
  if (source === "CMC" && finitePositive(row.cost_price)) return row.cost_price;
  return null;
}
function estimarCustoParaRanking(row: CostRow | null | undefined, price: number): number | null {
  const real = resolverCustoConfiavel(row);
  if (real != null) return real;
  const source = normalizarSource(row?.cost_source);
  const cf = row?.cost_final ?? null;
  if (source != null && COST_SOURCES_PROXY.has(source) && finitePositive(cf) && cf < price) return cf;
  return null;
}
type MargensCandidato = { custoConfiavel: number | null; custoRanking: number | null; margemExibida: number | null; margemRanking: number | null };
function derivarMargensCandidato(row: CostRow | null | undefined, price: number): MargensCandidato {
  const custoConfiavel = resolverCustoConfiavel(row);
  const custoRanking = estimarCustoParaRanking(row, price);
  return {
    custoConfiavel,
    custoRanking,
    margemExibida: custoConfiavel != null ? price - custoConfiavel : null,
    margemRanking: custoRanking != null ? price - custoRanking : null,
  };
}
// ======== /COST CONTRACT ========
```

- [ ] **Step 2: Buscar `cost_price`, tipar `costMap` como `CostRow`, e tornar `Candidate` nullable**

**(a) Incluir `cost_price` no SELECT de custos** — a régua usa o fallback CMC→`cost_price` (os 14 do syncInventory). Hoje a coluna não é buscada. Linha ~74, trocar:

```ts
    db.from("product_costs").select("product_id, cost_final, cost_source, cost_confidence"),
```
por:
```ts
    db.from("product_costs").select("product_id, cost_price, cost_final, cost_source, cost_confidence"),
```

**(b) Tipar `costMap` como `CostRow`** (linha ~103), trocar:

```ts
  const costMap: Record<string, { cost_final: number; cost_source: string; cost_confidence: number }> = {};
```
por:
```ts
  const costMap: Record<string, CostRow> = {};
```
(o loop `for (const c of costs || []) costMap[c.product_id] = c;` na linha ~104 permanece — `costs` é frouxamente tipado pelo client sem `<Database>`.)

**(c) `interface Candidate`** (linhas ~31-54): trocar `cost_final: number` → `cost_final: number | null`; inserir `cost_ranking: number | null;` após `cost_confidence: number;`; trocar `margin: number;` → `margin: number | null;`. (`cost_source: string` e `cost_confidence: number` permanecem — recebem default no push.)

- [ ] **Step 3: Trocar o cálculo de custo/margem no loop de candidatos**

Substituir o bloco (linhas ~153-158):

```ts
    const cost = costMap[p.id];
    const costFinal = cost?.cost_final || 0;
    const price = p.valor_unitario || 0;
    if (price <= 0) continue;

    const margin = price - costFinal;
```

por:

```ts
    const cost = costMap[p.id];
    const price = p.valor_unitario || 0;
    if (price <= 0) continue;

    const { custoConfiavel, custoRanking, margemExibida, margemRanking } = derivarMargensCandidato(cost ?? null, price);
    const margemRank = margemRanking ?? 0; // EIP neutro (0, não máximo) quando custo de ranking ausente
```

- [ ] **Step 4: EIP/EILTV usam a margem de ranking**

Trocar (linha ~174): `const eip = probability * margin;` → `const eip = probability * margemRank;`

Trocar (linha ~176): `const eiltv = probability * (margin + kappa * recurrenceScore * margin);` → `const eiltv = probability * (margemRank + kappa * recurrenceScore * margemRank);`

- [ ] **Step 5: Explicação de margem gateada por margem REAL conhecida**

Trocar (linhas ~195-197):

```ts
    } else if (margin > 50) {
      explanationKey = "margin";
      explanationText = `${p.descricao} tem alto potencial de margem (R$ ${margin.toFixed(2)})`;
```

por:

```ts
    } else if (margemExibida != null && margemExibida > 50) {
      explanationKey = "margin";
      explanationText = `${p.descricao} tem alto potencial de margem (R$ ${margemExibida.toFixed(2)})`;
```

- [ ] **Step 6: `candidates.push` usa custo confiável (exibido) + ranking**

No objeto `candidates.push({ ... })` (linhas ~205-214), trocar:
- `cost_final: costFinal,` → `cost_final: custoConfiavel,`
- `cost_confidence: cost?.cost_confidence || 0, familia: p.familia,` → `cost_confidence: cost?.cost_confidence || 0, cost_ranking: custoRanking, familia: p.familia,`
- `estoque: p.estoque || 0, margin, assoc_score: assoc,` → `estoque: p.estoque || 0, margin: margemExibida, assoc_score: assoc,`

- [ ] **Step 7: Resposta expõe `estimated_cost_for_ranking`**

No `_admin` da resposta (linhas ~274-279), trocar:

```ts
      _admin: {
        cost_final: c.cost_final, cost_source: c.cost_source,
        cost_confidence: c.cost_confidence, assoc_score: c.assoc_score,
```

por:

```ts
      _admin: {
        cost_final: c.cost_final, cost_source: c.cost_source,
        cost_confidence: c.cost_confidence, estimated_cost_for_ranking: c.cost_ranking,
        assoc_score: c.assoc_score,
```

> O log (`unit_cost: c.cost_final`, `margin: c.margin`, linhas ~252/254) **não muda de forma** — os valores agora são `number | null` e as colunas `recommendation_log.unit_cost/margin` já são nullable.

- [ ] **Step 8: Verificar tipos do edge (deno) + lint**

Run: `deno check supabase/functions/recommend/index.ts`
Expected: sem erros de tipo (downloads de `npm:` na 1ª vez são normais).

Run: `bun run lint -- supabase/functions/recommend/index.ts` (ou `bun run lint` e confirmar que o arquivo não introduz erro)
Expected: 0 erros novos.

**Paridade verbatim:** confirmar que o bloco entre os marcadores `COST CONTRACT` é byte-idêntico às funções de `src/lib/custos/cost-source.ts` (mesma lógica; só sem `export`).

Run: `git diff --no-index <(sed -n '/COST CONTRACT (espelho/,/\/COST CONTRACT/p' supabase/functions/recommend/index.ts | grep -E 'return|finitePositive|COST_SOURCES|normalizarSource|cost_final|cost_price') <(grep -E 'return|finitePositive|COST_SOURCES|normalizarSource|cost_final|cost_price' src/lib/custos/cost-source.ts) || echo "revisar manualmente as diferenças acima"`
Expected: diferenças só de `export ` (esperado) — nenhuma diferença de lógica.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/recommend/index.ts
git commit -m "fix(recommend): custo ausente ≠ R\$0 — margem exibida null + estimated_cost_for_ranking (espelho verbatim)"
```

---

### Task 4: `algorithm-a-audit` edge — espelhar helpers + gap cost-free

**Files:**
- Modify: `supabase/functions/algorithm-a-audit/index.ts`

- [ ] **Step 1: Colar o bloco-espelho dos helpers**

Em `supabase/functions/algorithm-a-audit/index.ts`, após os imports (linha ~2, depois de `import { authorizeCronOrStaff }...`), inserir o bloco-espelho de `cost-source` (idêntico ao Step 1 da Task 3) E o de `auditoria-margem`:

```ts
// ======== COST CONTRACT (espelho VERBATIM de src/lib/custos/cost-source.ts — manter idêntico) ========
type CostRow = { cost_price: number | null; cost_final: number | null; cost_source: string | null; cost_confidence: number | null };
const COST_SOURCES_REAIS = new Set(["PRODUCT_COST", "CMC"]);
function finitePositive(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}
function normalizarSource(source: string | null | undefined): string | null {
  const s = source?.trim().toUpperCase();
  return s ? s : null;
}
function resolverCustoConfiavel(row: CostRow | null | undefined): number | null {
  const source = normalizarSource(row?.cost_source);
  if (row == null || source == null || !COST_SOURCES_REAIS.has(source)) return null;
  if (finitePositive(row.cost_final)) return row.cost_final;
  if (source === "CMC" && finitePositive(row.cost_price)) return row.cost_price;
  return null;
}
// ======== AUDIT CORE (espelho VERBATIM de src/lib/custos/auditoria-margem.ts — manter idêntico) ========
type AuditOrderLine = { product_id: string | null; unit_price: number | null; discount: number | null; quantity: number | null };
type AuditoriaCliente = {
  margin_real: number | null; margin_potential: number | null; margin_gap: number;
  gap_pct: number | null; top_gap_products: { product_id: string; gap: number }[]; cobertura_custo: number;
};
const COBERTURA_CUSTO_MIN = 0.85;
const round2 = (x: number) => Math.round(x * 100) / 100;
function calcularAuditoriaMargemCliente(input: {
  orders: AuditOrderLine[];
  custoPorProduto: (productId: string) => CostRow | null | undefined;
  bestPrice: (productId: string) => number | null | undefined;
}): AuditoriaCliente {
  let marginGap = 0, bestRevenue = 0, receita = 0, marginRealKnown = 0, marginPotentialKnown = 0, receitaComCusto = 0;
  const topGap: { product_id: string; gap: number }[] = [];
  for (const o of input.orders) {
    if (!o.product_id) continue;
    const qty = Number(o.quantity);
    const up = Number(o.unit_price);
    if (!Number.isFinite(qty) || !Number.isFinite(up)) continue;
    const actualPrice = up * (1 - Number(o.discount || 0) / 100);
    const bp = input.bestPrice(o.product_id);
    const bestPrice = typeof bp === "number" && Number.isFinite(bp) ? bp : actualPrice;
    const leak = (bestPrice - actualPrice) * qty;
    marginGap += leak;
    bestRevenue += bestPrice * qty;
    receita += actualPrice * qty;
    if (leak > 0) topGap.push({ product_id: o.product_id, gap: leak });
    const custo = resolverCustoConfiavel(input.custoPorProduto(o.product_id));
    if (custo != null) {
      marginRealKnown += (actualPrice - custo) * qty;
      marginPotentialKnown += (bestPrice - custo) * qty;
      receitaComCusto += actualPrice * qty;
    }
  }
  topGap.sort((a, b) => b.gap - a.gap);
  const cobertura_custo = receita > 0 ? receitaComCusto / receita : 0;
  const temCobertura = cobertura_custo >= COBERTURA_CUSTO_MIN;
  return {
    margin_real: temCobertura ? round2(marginRealKnown) : null,
    margin_potential: temCobertura ? round2(marginPotentialKnown) : null,
    margin_gap: round2(marginGap),
    gap_pct: bestRevenue > 0 ? round2((marginGap / bestRevenue) * 100) : null,
    top_gap_products: topGap.slice(0, 5),
    cobertura_custo,
  };
}
// ======== /AUDIT CORE ========
```

- [ ] **Step 2: Ampliar `ProductCostRow` e o select**

Trocar a interface (linhas ~17-21):

```ts
interface ProductCostRow {
  product_id: string;
  cost_final: number | null;
  family_category: string | null;
}
```

por:

```ts
interface ProductCostRow {
  product_id: string;
  cost_price: number | null;
  cost_final: number | null;
  cost_source: string | null;
  cost_confidence: number | null;
  family_category: string | null;
}
```

Trocar o select (linha ~103):

```ts
    const productCosts = await fetchAllPaginated<ProductCostRow>(supabase, 'product_costs', 'product_id, cost_final, family_category');
```

por:

```ts
    const productCosts = await fetchAllPaginated<ProductCostRow>(supabase, 'product_costs', 'product_id, cost_price, cost_final, cost_source, cost_confidence, family_category');
```

- [ ] **Step 3: `costMap` guarda a linha inteira (não `Number(cost_final||0)`)**

Trocar (linhas ~129-133):

```ts
    // Build cost map
    const costMap: Record<string, number> = {};
    productCosts.forEach(pc => {
      costMap[pc.product_id] = Number(pc.cost_final || 0);
    });
```

por:

```ts
    // Build cost map (linha inteira — a régua resolverCustoConfiavel decide o custo confiável)
    const costMap: Record<string, ProductCostRow> = {};
    productCosts.forEach(pc => { costMap[pc.product_id] = pc; });
```

- [ ] **Step 4: `AuditRecord` nullable nos níveis absolutos**

Trocar (linhas ~36-46) os 3 campos:
- `margin_real: number;` → `margin_real: number | null;`
- `margin_potential: number;` → `margin_potential: number | null;`
- `gap_pct: number;` → `gap_pct: number | null;`
(`margin_gap: number;` permanece — sempre numérico.)

- [ ] **Step 5: Substituir o loop por-cliente pelo helper**

Trocar o corpo do loop (linhas ~152-190, do `let marginReal = 0;` até o `auditRecords.push({...})` inclusive):

```ts
      let marginReal = 0;
      let marginPotential = 0;
      const topGapProducts: { product_id: string; gap: number }[] = [];

      for (const order of orders) {
        if (!order.product_id) continue;
        const cost = costMap[order.product_id] || 0;
        const actualPrice = Number(order.unit_price) * (1 - Number(order.discount || 0) / 100);
        const bestPrice = bestPriceMap[order.product_id] || actualPrice;
        const qty = Number(order.quantity);

        const realMargin = (actualPrice - cost) * qty;
        const potentialMargin = (bestPrice - cost) * qty;

        marginReal += realMargin;
        marginPotential += potentialMargin;

        const gap = potentialMargin - realMargin;
        if (gap > 0) {
          topGapProducts.push({ product_id: order.product_id, gap });
        }
      }

      const marginGap = marginPotential - marginReal;
      const gapPct = marginPotential > 0 ? (marginGap / marginPotential) * 100 : 0;

      topGapProducts.sort((a, b) => b.gap - a.gap);

      auditRecords.push({
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        period_start: periodStart,
        period_end: periodEnd,
        margin_real: Math.round(marginReal * 100) / 100,
        margin_potential: Math.round(marginPotential * 100) / 100,
        margin_gap: Math.round(marginGap * 100) / 100,
        gap_pct: Math.round(gapPct * 100) / 100,
        top_gap_products: topGapProducts.slice(0, 5),
      });
```

por:

```ts
      const a = calcularAuditoriaMargemCliente({
        orders,
        custoPorProduto: (id) => costMap[id] ?? null,
        bestPrice: (id) => bestPriceMap[id] ?? null,
      });

      auditRecords.push({
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        period_start: periodStart,
        period_end: periodEnd,
        margin_real: a.margin_real,
        margin_potential: a.margin_potential,
        margin_gap: a.margin_gap,
        gap_pct: a.gap_pct,
        top_gap_products: a.top_gap_products,
      });
```

> `bestPriceMap` continua sendo `Record<string, number>` construído acima (linhas ~122-127), inalterado.

- [ ] **Step 6: Verificar tipos do edge (deno) + paridade**

Run: `deno check supabase/functions/algorithm-a-audit/index.ts`
Expected: sem erros de tipo.

**Paridade:** confirmar que os blocos `COST CONTRACT` e `AUDIT CORE` são idênticos (lógica) aos `src/lib/custos/*.ts`.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/algorithm-a-audit/index.ts
git commit -m "fix(algorithm-a-audit): custo ausente ≠ R\$0 — gap cost-free + margens cobertura-gated (espelho verbatim)"
```

---

### Task 5: Frontend `recommend` — tipos nullable + `fmt` null-safe

**Files:**
- Modify: `src/hooks/useRecommendationEngine.ts:10,18-28`
- Modify: `src/components/RecommendationCard.tsx:10`

- [ ] **Step 1: Tipos do hook nullable + novo campo**

Em `src/hooks/useRecommendationEngine.ts`, no `interface RecommendationItem`:
- `margin: number;` (linha 10) → `margin: number | null;`
- No bloco `_admin?`: `cost_final: number;` (linha 19) → `cost_final: number | null;`
- Adicionar após essa linha: `estimated_cost_for_ranking: number | null;`

Resultado do `_admin`:

```ts
  _admin?: {
    cost_final: number | null;
    estimated_cost_for_ranking: number | null;
    cost_source: string;
    cost_confidence: number;
    assoc_score: number;
    sim_score: number;
    ctx_score: number;
    penalties: number;
    familia: string | null;
    eiltv: number;
  };
```

- [ ] **Step 2: `fmt` null-safe no card**

Em `src/components/RecommendationCard.tsx`, trocar (linha 10):

```ts
const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
```

por:

```ts
const fmt = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
```

> Isso cobre `fmt(item.margin)` (linha 81 → "—" quando custo não confiável), `fmt(item._admin.cost_final)` (linha 120) e os `fmt(item.eip)`/`fmt(item._admin.eiltv)` (sempre numéricos, inalterados na prática). Nenhuma outra mudança no card.

- [ ] **Step 3: Verificar tipos + lint**

Run: `heavy bun run typecheck`
Expected: PASS (sem erro novo em useRecommendationEngine/RecommendationCard).

Run: `bun run lint`
Expected: 0 erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useRecommendationEngine.ts src/components/RecommendationCard.tsx
git commit -m "fix(recommend-ui): margin/cost_final nullable → '—' (fmt null-safe) + estimated_cost_for_ranking"
```

---

### Task 6: Frontend auditoria — "—" para níveis null

**Files:**
- Modify: `src/components/intelligence/IntelligenceStrategicTab.tsx:184-187`
- Modify: `src/pages/GovernanceAudit.tsx:430-436`

- [ ] **Step 1: `IntelligenceStrategicTab` — células null-safe**

Em `src/components/intelligence/IntelligenceStrategicTab.tsx`, trocar as 4 células (linhas 184-187):

```tsx
                      <td className="text-center py-2">R$ {Number(row.margin_real).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-center py-2">R$ {Number(row.margin_potential).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-center py-2 text-destructive">R$ {Number(row.margin_gap).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-center py-2">{Number(row.gap_pct).toFixed(1)}%</td>
```

por:

```tsx
                      <td className="text-center py-2">{row.margin_real == null ? '—' : `R$ ${Number(row.margin_real).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`}</td>
                      <td className="text-center py-2">{row.margin_potential == null ? '—' : `R$ ${Number(row.margin_potential).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`}</td>
                      <td className="text-center py-2 text-destructive">R$ {Number(row.margin_gap).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-center py-2">{row.gap_pct == null ? '—' : `${Number(row.gap_pct).toFixed(1)}%`}</td>
```

> `margin_gap` permanece (sempre numérico). As somas `totalMarginReal`/`Potential` (linhas 65-66) já usam `Number(r.margin_real || 0)` → null é pulado (total parcial; aceitável).

- [ ] **Step 2: `GovernanceAudit` — células + badge null-safe**

Em `src/pages/GovernanceAudit.tsx`, trocar (linhas 430-437):

```tsx
                            <td className="text-center py-2">R$ {Number(row.margin_real).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2">R$ {Number(row.margin_potential).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2 text-destructive font-medium">R$ {Number(row.margin_gap).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2">
                              <Badge variant={Number(row.gap_pct) > 20 ? 'destructive' : 'secondary'} className="text-2xs">
                                {Number(row.gap_pct).toFixed(1)}%
                              </Badge>
                            </td>
```

por:

```tsx
                            <td className="text-center py-2">{row.margin_real == null ? '—' : `R$ ${Number(row.margin_real).toLocaleString('pt-BR')}`}</td>
                            <td className="text-center py-2">{row.margin_potential == null ? '—' : `R$ ${Number(row.margin_potential).toLocaleString('pt-BR')}`}</td>
                            <td className="text-center py-2 text-destructive font-medium">R$ {Number(row.margin_gap).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2">
                              {row.gap_pct == null ? <span className="text-muted-foreground">—</span> : (
                                <Badge variant={Number(row.gap_pct) > 20 ? 'destructive' : 'secondary'} className="text-2xs">
                                  {Number(row.gap_pct).toFixed(1)}%
                                </Badge>
                              )}
                            </td>
```

- [ ] **Step 3: Verificar tipos + lint**

Run: `heavy bun run typecheck`
Expected: PASS.

Run: `bun run lint`
Expected: 0 erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/components/intelligence/IntelligenceStrategicTab.tsx src/pages/GovernanceAudit.tsx
git commit -m "fix(auditoria-ui): níveis margin_real/potential/gap_pct null → '—' (vazamento% cost-free)"
```

---

### Task 7: Verificação final + Codex challenge + handoff de deploy

**Files:** nenhum (gate de qualidade).

- [ ] **Step 1: Suite completa verde**

Run: `heavy bun run typecheck && bun run lint && heavy bun run test src/lib/custos`
Expected: typecheck PASS · lint 0 erro · vitest dos 2 helpers PASS.

- [ ] **Step 2: Re-check dos edges (deno)**

Run: `deno check supabase/functions/recommend/index.ts supabase/functions/algorithm-a-audit/index.ts`
Expected: sem erros.

- [ ] **Step 3: `/codex challenge` no diff (adversarial money-path)**

Run: `git diff main...HEAD` e submeter ao Codex (`gpt-5.5`, reasoning `xhigh` — money-path). Foco adversário: (a) algum caminho ainda fabrica custo 0? (b) `estimated_cost_for_ranking` vaza como margem firme em algum lugar? (c) a mudança de semântica do `gap_pct` (vazamento%) está coerente com numerador/denominador? (d) paridade edge×src é byte-idêntica?
Registrar o veredito no corpo do PR. Se a cota do Codex estiver esgotada → Caminho B (auto-challenge + `REVISÃO INDEPENDENTE PENDENTE`).

- [ ] **Step 4: Abrir PR (NÃO-draft só após Codex verde)**

```bash
git push -u origin claude/agitated-ellis-ff1133
gh pr create --title "fix(money-path): custo ausente ≠ R\$0 em recommend + algorithm-a-audit (cost_source-aware)" --body "<resumo + link spec/plano + veredito Codex + checklist de deploy manual>"
```
> Auto-merge (squash) dispara no CI verde. Para segurar, manter DRAFT.

- [ ] **Step 5: Handoff de deploy MANUAL (merge ≠ produção)**

Após o merge, lembrar o founder (não auto-aplica):
1. **Edge `recommend`** — chat do Lovable, colar verbatim de `supabase/functions/recommend/index.ts`.
2. **Edge `algorithm-a-audit`** — idem.
3. **Frontend** — Publish no editor do Lovable (RecommendationCard + as 2 telas de auditoria).
4. **Sem migration.** Verificar pós-deploy: uma recomendação de produto sem custo mostra "Margem —" (não R$ cheio); painel de governança mostra "Vazamento %".

---

## Notas de execução

- **`heavy`** prefixa test/typecheck (semáforo de RAM M2 8GB).
- **Não tocar** `src/lib/financeiro/valor-cockpit-helpers.ts` (QUENTE — PR #959).
- Ordem importa: Tasks 1-2 (helpers provados) antes de 3-4 (edges espelham) antes de 5-6 (frontend consome). Task 3 e 4 são independentes entre si; 5 e 6 idem.
- `bun run lint -- <arquivo>` pode não filtrar por arquivo dependendo do script; na dúvida rodar `bun run lint` inteiro e conferir que o delta de erros é 0.
