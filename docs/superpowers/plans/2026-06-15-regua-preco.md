# Régua de Preço — Implementation Plan (núcleo: helper + RPC + log) · v2 pós-challenge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o motor determinístico de benchmark de preço por (cliente, SKU) — helper puro testável + RPC SQL + log closed-loop — que diz "este preço está X% abaixo do custo+imposto / de vendas comparáveis", sem nunca estimar aceite.

**Architecture:** Helper puro TS (`regua-preco-helpers.ts`) é o **oráculo** com todas as fórmulas/gates/hierarquia, testado por vitest (TDD). Uma RPC SQL `get_regua_preco` espelha o helper e busca os comparáveis controlados (mesmo SKU + account=oben + banda de quantidade tolerante + 180d + leave-one-customer-out). Uma tabela `regua_preco_log` grava exposição + outcome desde o dia 1. **Zero LLM no número.** A UI é o **PR3-4, plano separado**.

**Tech Stack:** TS 5.8 strict · vitest (`bun run test`) · Supabase Postgres (`lovable-db-operator` + `prove-sql-money-path`).

**Premissas (PR0, spec §10.1):** `unit_price` líquido (desconto 0%); janela 180d; CMC ~78% via `inventory_position.account ∈ {oben,vendas}`; alíquota = `(icms+pis+cofins)/receita` de `fin_kpi_tributario`.

**Correções do challenge do Codex incorporadas (v2):** (P0) gap observado vs sugerido separados · teto = min(refs) · discordância degrada · guard `precoAtual>0` · CMC proxy sem botão · SQL `n_eff` com cast `::numeric`. (P1) `calcAutoRef` nearest-rank (valor real, não interpola) + confiança ≤ média · preço-acima-das-referências usa a evidência real, não "baixa" · gates com nível "baixa/recibo" (`n>=8/n_eff>=3`) sem afrouxar botão · banda de quantidade tolerante. (P2) `percentil` com guards · teste p65 = 119,5 · prove-sql compara o objeto inteiro · edge cases listados.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/regua-preco/types.ts` | Tipos: `ReguaPrecoInput`, `ReguaPrecoResult`, `TipoSinal`, `Confianca` |
| `src/lib/regua-preco/regua-preco-helpers.ts` | Oráculo puro: `percentil`, `calcPisoMC`, `calcAutoRef`, `calcBenchmark`, `avaliarReguaPreco` |
| `src/lib/regua-preco/__tests__/regua-preco-helpers.test.ts` | Testes vitest (TDD) |
| `supabase/migrations/<ts>_regua_preco_rpc.sql` | RPC `get_regua_preco` (espelha o helper) |
| `supabase/migrations/<ts>_regua_preco_log.sql` | Tabela `regua_preco_log` + RLS |

---

## PR1 — Helper puro (oráculo, TDD)

### Task 1: Tipos

**Files:** Create `src/lib/regua-preco/types.ts`

- [ ] **Step 1: Escrever os tipos**

```ts
export type Confianca = 'alta' | 'media' | 'baixa' | 'oculto';
export type TipoSinal = 'piso' | 'auto_ref' | 'benchmark' | 'nenhum';

export interface ReguaPrecoInput {
  precoAtual: number;                 // unit_price líquido no carrinho
  cmc: number | null;                 // custo médio contábil; null se sem cobertura
  cmcConfiavel: boolean;              // false = proxy → aviso sem botão
  aliquotaVenda: number;              // (icms+pis+cofins)/receita, 0..1
  precosCliente: number[];            // preços recentes (180d) que ESTE cliente pagou neste SKU
  comparaveis: { preco: number; clienteId: string }[]; // vendas comparáveis (EXCLUI cliente atual)
  caps: { alta: number; media: number }; // cap de aumento por confiança, ex {alta:0.10, media:0.05}
}

export interface ReguaPrecoResult {
  sinal: TipoSinal;
  confianca: Confianca;               // qualidade da EVIDÊNCIA (nunca "chance de aceite")
  precoReferencia: number | null;     // alvo sugerido capado; null se sem ação (baixa/oculto/proxy)
  observedGapPct: number | null;      // teto/atual - 1 — oportunidade OBSERVADA (não capada) — p/ log
  suggestedGapPct: number | null;     // alvo capado/atual - 1 — o que a UI sugere
  pisoMC: number | null;
  abaixoPiso: boolean;
  capLimitou: boolean;                // o cap reduziu a sugestão abaixo do teto
  discordancia: boolean;              // auto_ref e benchmark apontam direções opostas
  recibos: string[];
  disclaimers: string[];              // SEMPRE inclui os 2 fixos
  reasonCodes: string[];              // 'cmc_proxy','sinais_discordantes','preco_acima_referencias',...
}

export const DISCLAIMERS_FIXOS = [
  'Não estimamos aceite do cliente.',
  'Não controlado por prazo de pagamento/frete.',
];
```

- [ ] **Step 2: Commit** — `git add src/lib/regua-preco/types.ts && git commit -m "feat(regua-preco): tipos do motor (v2)"`

### Task 2: `percentil` (com guards)

**Files:** Create helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { describe, it, expect } from 'vitest';
import { percentil } from '../regua-preco-helpers';

describe('percentil (R-7, casa com percentile_cont do SQL)', () => {
  it('p65 por interpolação linear', () => {
    expect(percentil([100, 110, 120, 130], 0.65)).toBeCloseTo(119.5, 6); // corrigido (era 119)
  });
  it('ignora valores não-finitos', () => {
    expect(percentil([100, NaN, 120, Infinity], 0.5)).toBe(110);
  });
  it('vazio / p fora de [0,1] → null', () => {
    expect(percentil([], 0.65)).toBeNull();
    expect(percentil([100], 1.5)).toBeNull();
  });
  it('um elemento → ele mesmo', () => expect(percentil([100], 0.65)).toBe(100));
});
```

- [ ] **Step 2: Rodar e ver falhar** — `bun run test regua-preco`

- [ ] **Step 3: Implementar**

```ts
import { Confianca, TipoSinal, ReguaPrecoInput, ReguaPrecoResult, DISCLAIMERS_FIXOS } from './types';

/** Percentil R-7 (interpolação linear) — casa com percentile_cont. Filtra não-finitos; null se vazio ou p∉[0,1]. */
export function percentil(xs: number[], p: number): number | null {
  if (!(p >= 0 && p <= 1)) return null;
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return null;
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (idx - lo) * (s[hi] - s[lo]);
}
```

- [ ] **Step 4: Rodar e ver passar** · **Step 5: Commit** — `git commit -am "feat(regua-preco): percentil util com guards (TDD)"`

### Task 3: `calcPisoMC` (sinal 🔴)

**Files:** helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { calcPisoMC } from '../regua-preco-helpers';
describe('calcPisoMC = cmc/(1-aliquota)', () => {
  it('cmc 98, aliq 14% → 113.95', () => expect(calcPisoMC(98, 0.14)).toBeCloseTo(113.95, 2));
  it('cmc null → null', () => expect(calcPisoMC(null, 0.14)).toBeNull());
  it('aliquota inválida → null', () => {
    expect(calcPisoMC(98, 1)).toBeNull();
    expect(calcPisoMC(98, -0.1)).toBeNull();
  });
});
```

- [ ] **Step 2: falhar** · **Step 3: Implementar**

```ts
export function calcPisoMC(cmc: number | null, aliquotaVenda: number): number | null {
  if (cmc == null || !Number.isFinite(cmc) || cmc <= 0) return null;
  if (!(aliquotaVenda >= 0 && aliquotaVenda < 1)) return null;
  return cmc / (1 - aliquotaVenda);
}
```

- [ ] **Step 4: passar** · **Step 5: Commit** — `git commit -am "feat(regua-preco): calcPisoMC (TDD)"`

### Task 4: `calcAutoRef` (nearest-rank — valor REAL, nunca interpola)

**Files:** helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { calcAutoRef } from '../regua-preco-helpers';
describe('calcAutoRef', () => {
  it('nunca inventa preço: [100,200] → 100 ou 200, nunca 150/160', () => {
    const r = calcAutoRef([100, 200])!;
    expect([100, 200]).toContain(r.ref);
  });
  it('>=3 obs → media (1 cliente nunca é alta)', () => {
    expect(calcAutoRef([110, 112, 115])!.confianca).toBe('media');
  });
  it('1-2 obs → baixa', () => expect(calcAutoRef([112])!.confianca).toBe('baixa'));
  it('vazio / lixo → null', () => {
    expect(calcAutoRef([])).toBeNull();
    expect(calcAutoRef([NaN, -5])).toBeNull();
  });
});
```

- [ ] **Step 2: falhar** · **Step 3: Implementar**

```ts
/** Referência do próprio cliente: mediana nearest-rank (valor REALMENTE pago) dos preços recentes (já filtrados 180d pela RPC). */
export function calcAutoRef(precosCliente: number[]): { ref: number; confianca: Confianca } | null {
  const s = precosCliente.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const ref = s[Math.ceil(0.5 * s.length) - 1]; // nearest-rank p50 → sempre um valor real
  return { ref, confianca: s.length >= 3 ? 'media' : 'baixa' }; // 1 cliente = ruído de negociação, nunca 'alta'
}
```

- [ ] **Step 4: passar** · **Step 5: Commit** — `git commit -am "feat(regua-preco): calcAutoRef nearest-rank (TDD)"`

### Task 5: `calcBenchmark` (p65 + n_eff + nível recibo)

**Files:** helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { calcBenchmark } from '../regua-preco-helpers';
const gen = (precos: number[], nClientes: number) => precos.map((p, i) => ({ preco: p, clienteId: `c${i % nClientes}` }));
describe('calcBenchmark', () => {
  it('n>=15 & n_eff>=5 → media', () => {
    const r = calcBenchmark(gen(Array.from({ length: 16 }, (_, i) => 100 + i), 6));
    expect(r.confianca).toBe('media'); expect(r.nEff).toBeGreaterThanOrEqual(5);
  });
  it('n>=8 & n_eff>=3 (mas <media) → baixa (recibo, sem botão)', () => {
    expect(calcBenchmark(gen(Array.from({ length: 9 }, (_, i) => 100 + i), 4)).confianca).toBe('baixa');
  });
  it('SKU concentrado num cliente → n_eff baixo → oculto', () => {
    const comp = Array.from({ length: 20 }, (_, i) => ({ preco: 100 + i, clienteId: i < 18 ? 'c0' : `c${i}` }));
    expect(calcBenchmark(comp).confianca).toBe('oculto');
  });
  it('preços <=0 filtrados', () => {
    const r = calcBenchmark([{ preco: -1, clienteId: 'c0' }, ...gen([100, 110, 120], 3)]);
    expect(r.n).toBe(3);
  });
});
```

- [ ] **Step 2: falhar** · **Step 3: Implementar**

```ts
export function calcBenchmark(comparaveis: { preco: number; clienteId: string }[]): {
  pTarget: number | null; n: number; nEff: number; nClientes: number; confianca: Confianca;
} {
  const val = comparaveis.filter((c) => Number.isFinite(c.preco) && c.preco > 0);
  const n = val.length;
  if (n === 0) return { pTarget: null, n: 0, nEff: 0, nClientes: 0, confianca: 'oculto' };
  const counts = new Map<string, number>();
  for (const c of val) counts.set(c.clienteId, (counts.get(c.clienteId) ?? 0) + 1);
  let somaShare2 = 0;
  for (const c of counts.values()) { const sh = c / n; somaShare2 += sh * sh; }
  const nEff = 1 / somaShare2;
  const pTarget = percentil(val.map((c) => c.preco), 0.65);
  let confianca: Confianca;
  if (n >= 30 && nEff >= 8) confianca = 'alta';
  else if (n >= 15 && nEff >= 5) confianca = 'media';
  else if (n >= 8 && nEff >= 3) confianca = 'baixa';   // recibo, sem botão
  else confianca = 'oculto';
  return { pTarget, n, nEff, nClientes: counts.size, confianca };
}
```

- [ ] **Step 4: passar** · **Step 5: Commit** — `git commit -am "feat(regua-preco): calcBenchmark com n_eff + nível recibo (TDD)"`

### Task 6: `avaliarReguaPreco` (orquestração blindada)

**Files:** helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { avaliarReguaPreco } from '../regua-preco-helpers';
import { DISCLAIMERS_FIXOS } from '../types';
const base = { precoAtual: 106, cmc: 98, cmcConfiavel: true, aliquotaVenda: 0.14,
  precosCliente: [] as number[], comparaveis: [] as {preco:number;clienteId:string}[], caps: { alta: 0.10, media: 0.05 } };
const benchAlto = (preco: number) => Array.from({ length: 16 }, (_, i) => ({ preco: preco + (i % 4), clienteId: `c${i % 6}` }));

describe('avaliarReguaPreco', () => {
  it('🔴 piso vence (MC negativa) com botão se CMC confiável', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 106 });
    expect(r.sinal).toBe('piso'); expect(r.abaixoPiso).toBe(true);
    expect(r.precoReferencia).not.toBeNull();
    expect(r.disclaimers).toEqual(expect.arrayContaining(DISCLAIMERS_FIXOS));
  });
  it('CMC proxy abaixo do piso → aviso SEM botão', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 106, cmcConfiavel: false });
    expect(r.sinal).toBe('piso'); expect(r.precoReferencia).toBeNull();
    expect(r.reasonCodes).toContain('cmc_proxy');
  });
  it('precoAtual<=0 → nenhum/oculto, não explode', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 0 });
    expect(r.sinal).toBe('nenhum'); expect(r.suggestedGapPct).toBeNull();
    expect(r.reasonCodes).toContain('preco_atual_invalido');
  });
  it('teto = min(auto,benchmark): auto 140 > bench 125 → referência respeita 125 e o cap', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 120, precosCliente: [140, 140, 140], comparaveis: benchAlto(125) });
    expect(r.precoReferencia!).toBeLessThanOrEqual(125 + 1e-9);
    expect(r.precoReferencia!).toBeLessThanOrEqual(120 * 1.10 + 1e-9); // cap
  });
  it('discordância (cliente paga MENOS, carteira MAIS) → degrada sem botão', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 120, precosCliente: [100, 100, 100], comparaveis: benchAlto(135) });
    expect(r.discordancia).toBe(true); expect(r.precoReferencia).toBeNull();
    expect(r.reasonCodes).toContain('sinais_discordantes');
  });
  it('preço já acima de tudo → nenhum, mas confiança = evidência real (não baixa)', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 200, comparaveis: benchAlto(120) });
    expect(r.sinal).toBe('nenhum'); expect(r.confianca).toBe('media');
    expect(r.reasonCodes).toContain('preco_acima_referencias');
  });
  it('observedGapPct (não capado) != suggestedGapPct (capado) quando o cap morde', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 100, precosCliente: [130, 130, 130], comparaveis: benchAlto(130) });
    expect(r.observedGapPct!).toBeGreaterThan(r.suggestedGapPct!);
    expect(r.capLimitou).toBe(true);
  });
});
```

- [ ] **Step 2: falhar** · **Step 3: Implementar**

```ts
const ORDEM: Confianca[] = ['oculto', 'baixa', 'media', 'alta'];
const maxConf = (a: Confianca, b: Confianca) => (ORDEM.indexOf(a) >= ORDEM.indexOf(b) ? a : b);
const capDe = (c: Confianca, caps: { alta: number; media: number }) =>
  c === 'alta' ? caps.alta : c === 'media' ? caps.media : 0;

export function avaliarReguaPreco(input: ReguaPrecoInput): ReguaPrecoResult {
  const { precoAtual, cmc, cmcConfiavel, aliquotaVenda, precosCliente, comparaveis, caps } = input;
  const disclaimers = [...DISCLAIMERS_FIXOS];
  const recibos: string[] = [];
  const reasonCodes: string[] = [];
  const out = (e: Partial<ReguaPrecoResult>): ReguaPrecoResult => ({
    sinal: 'nenhum', confianca: 'oculto', precoReferencia: null, observedGapPct: null,
    suggestedGapPct: null, pisoMC: null, abaixoPiso: false, capLimitou: false,
    discordancia: false, recibos, disclaimers, reasonCodes, ...e,
  });

  if (!Number.isFinite(precoAtual) || precoAtual <= 0) { reasonCodes.push('preco_atual_invalido'); return out({}); }

  const pisoMC = calcPisoMC(cmc, aliquotaVenda);
  const abaixoPiso = pisoMC != null && precoAtual < pisoMC;

  if (abaixoPiso) {
    if (!cmcConfiavel) {
      reasonCodes.push('cmc_proxy');
      recibos.push('Possível MC negativa por custo ESTIMADO (proxy). Confira o custo real.');
      return out({ sinal: 'piso', confianca: 'baixa', pisoMC, abaixoPiso });
    }
    recibos.push(`Custo+imposto ≈ piso R$ ${pisoMC!.toFixed(2)}; seu preço R$ ${precoAtual.toFixed(2)} (MC negativa).`);
    const gap = pisoMC! / precoAtual - 1;
    return out({ sinal: 'piso', confianca: 'alta', precoReferencia: pisoMC, observedGapPct: gap, suggestedGapPct: gap, pisoMC, abaixoPiso });
  }

  const auto = calcAutoRef(precosCliente);
  const bench = calcBenchmark(comparaveis);
  const benchValido = bench.pTarget != null && bench.confianca !== 'oculto';
  const evidenciaMax = maxConf(auto?.confianca ?? 'oculto', benchValido ? bench.confianca : 'oculto');
  const dir = (ref?: number | null) => (ref == null ? 'ausente' : ref > precoAtual ? 'acima' : 'abaixo');
  const dirAuto = dir(auto?.ref), dirBench = dir(benchValido ? bench.pTarget : null);

  if ((dirAuto === 'acima' && dirBench === 'abaixo') || (dirAuto === 'abaixo' && dirBench === 'acima')) {
    reasonCodes.push('sinais_discordantes');
    recibos.push(`Cliente costuma pagar ~R$ ${auto!.ref.toFixed(2)}; carteira p65 R$ ${bench.pTarget!.toFixed(2)}.`);
    return out({ sinal: 'nenhum', confianca: 'baixa', pisoMC, discordancia: true });
  }

  const tetos: { sinal: TipoSinal; ref: number; confianca: Confianca }[] = [];
  if (dirAuto === 'acima') tetos.push({ sinal: 'auto_ref', ref: auto!.ref, confianca: auto!.confianca });
  if (dirBench === 'acima') tetos.push({ sinal: 'benchmark', ref: bench.pTarget!, confianca: bench.confianca });

  if (tetos.length === 0) { reasonCodes.push('preco_acima_referencias'); return out({ sinal: 'nenhum', confianca: evidenciaMax, pisoMC }); }

  const teto = Math.min(...tetos.map((t) => t.ref));
  const copy = tetos.find((t) => t.sinal === 'auto_ref') ?? tetos[0]; // copy: auto_ref preferida; número: teto conservador
  const confianca = copy.confianca;
  const observedGapPct = teto / precoAtual - 1;
  const cap = capDe(confianca, caps);

  if (cap === 0) { // confiança baixa → recibo sem %
    reasonCodes.push('evidencia_fraca');
    recibos.push(copy.sinal === 'auto_ref' ? 'Este cliente já pagou mais (amostra pequena).' : 'Vendas comparáveis acima (evidência fraca).');
    return out({ sinal: copy.sinal, confianca: 'baixa', pisoMC, observedGapPct });
  }

  const alvo = Math.min(teto, precoAtual * (1 + cap));
  const capLimitou = alvo < teto - 1e-9;
  recibos.push(copy.sinal === 'auto_ref'
    ? `Você já cobrou ~R$ ${copy.ref.toFixed(2)} deste cliente neste item.`
    : `Comparáveis recentes (mesmo porte) no p65: R$ ${bench.pTarget!.toFixed(2)}.`);
  if (tetos.some((t) => t.sinal === 'benchmark')) disclaimers.push(`Base: ${bench.n} vendas, ${bench.nClientes} clientes, 180d, exclui este cliente.`);
  if (capLimitou) recibos.push(`Sugestão limitada ao cap +${(cap * 100).toFixed(0)}% (oportunidade observada +${(observedGapPct * 100).toFixed(0)}%).`);

  return out({ sinal: copy.sinal, confianca, precoReferencia: alvo, observedGapPct,
    suggestedGapPct: Math.max(0, alvo / precoAtual - 1), pisoMC, abaixoPiso: false, capLimitou });
}
```

- [ ] **Step 4: passar** · **Step 5: Typecheck + commit** — `heavy bun run typecheck && git commit -am "feat(regua-preco): avaliarReguaPreco blindado pós-challenge (TDD)"`

### Task 7: Falsificação (provar que a malha morde)

- [ ] **Step 1:** Inverter `precoAtual < pisoMC` → `>`: o teste do 🔴 fica vermelho. Reverter.
- [ ] **Step 2:** Trocar `teto = Math.min(...)` por `Math.max(...)`: o teste "teto = min(auto,benchmark)" fica vermelho. Reverter.
- [ ] **Step 3:** Remover o ramo de discordância: o teste de discordância fica vermelho. Reverter. (Sem commit — só validação.)

---

## PR2 — RPC SQL + log (ritual da casa)

> **SUB-SKILLS OBRIGATÓRIAS:** `prove-sql-money-path` (PG17 local) + `lovable-db-operator` (handoff do SQL Editor). Money-path: NÃO entregar sem prova executando.

### Task 8: RPC `get_regua_preco`

**Files:** Create `supabase/migrations/<ts>_regua_preco_rpc.sql`

- [ ] **Step 1: Pré-flight (questão aberta PR0):** via `psql-ro`, decidir o `inventory_position.account` canônico (`oben` vs `vendas`) comparando CMC contra custo conhecido de 3-4 SKUs. Documentar no topo da migration.
- [ ] **Step 2:** RPC `get_regua_preco(p_customer uuid, p_product uuid, p_qty numeric)` SECURITY DEFINER + gate staff, espelhando o helper:
  - `comparaveis` = `order_items ⋈ sales_orders` (account=oben, `order_date_kpi >= now()-interval '180 days'`, `deleted_at IS NULL`, mesmo `product_id`, `customer_user_id <> p_customer`, **banda de quantidade tolerante:** `quantity BETWEEN p_qty*0.5 AND p_qty*2` e, se a amostra < mínimo, **expande** a banda / cai pro SKU inteiro **rebaixando a confiança** (nunca botão sem amostra na banda).
  - `precosCliente` = mesmas vendas com `customer_user_id = p_customer` (180d).
  - `cmc` ← `inventory_position` (account do Step 1); `cmcConfiavel` = veio de CMC real (não proxy).
  - `aliquotaVenda` ← `(icms+pis+cofins)/nullif(receita_bruta_acumulada,0)` de `fin_kpi_tributario` (company oben, mês recente); se receita 0/null → degradar (sem piso).
  - **`n_eff` com cast explícito:** `1 / sum( (cnt::numeric/total::numeric)^2 )` — nunca divisão inteira.
  - `percentile_cont(0.65)` para o p65 (casa com o R-7 do helper).
- [ ] **Step 3: PROVAR (paridade total)** — `prove-sql-money-path`: semear cenários (MC-negativa, SKU-concentrado, discordância, CMC-proxy, banda-expandida, preço-acima) e assertar que **o objeto inteiro** (sinal, precoReferencia, observedGapPct, suggestedGapPct, confianca, capLimitou, discordancia) bate com o helper TS para os mesmos inputs, **tolerância de centavos**. **Falsificar:** sabotar o `customer_user_id <>` (leave-one-out) e o cast do `n_eff` → exigir vermelho.
- [ ] **Step 4: Handoff** — `lovable-db-operator` (bloco SQL Editor + validação pós-apply + nota de PR).

### Task 9: Tabela `regua_preco_log`

**Files:** Create `supabase/migrations/<ts>_regua_preco_log.sql`

- [ ] **Step 1:** Tabela com os campos do spec §8 + **`observed_gap_pct` E `suggested_gap_pct`** (separados — correção P0 #1), `cap_limitou`, `reason_codes`, `evidence_version`.
- [ ] **Step 2:** RLS: `SELECT/INSERT` staff; `customer` sem acesso. Tabela nova sempre com RLS.
- [ ] **Step 3: PROVAR** — `prove-sql-money-path`: RLS sob `SET ROLE authenticated` + GUC (vendedor insere o próprio log; customer não lê). Falsificar (remover policy → vermelho).
- [ ] **Step 4: Handoff** — `lovable-db-operator`.

---

## PR3-PR4 — UI (plano separado, após o núcleo provado)

Fora deste plano (dependem do shape provado do `ReguaPrecoResult` + componentes do `unified-order`):
- **PR3:** `useReguaPreco` + `ReguaPrecoCard` (modos 🔴/💰; mostra `suggestedGapPct` no card e expõe `observedGapPct`+`capLimitou` no ⓘ; copy spec §6; disclaimers) + integração no carrinho + flag `regua_preco_carrinho` (sombra→balcão) + gravação no log.
- **PR4:** card no `Customer360` (reuso).

---

## Self-Review

**Spec coverage:** §3 sinais → T3-6 ✅ · §4 fórmulas → T2-6 ✅ · §5 confiança → T4-6 ✅ · §8 log → T9 (com gap observado/sugerido) ✅ · §10.1 premissas → header + T8 ✅ · §6 UI → PR3 (declarado) ✅.
**Challenge coverage:** P0 #1 gap obs/sug → T1+T6+T9 ✅ · #2 teto=min → T6 ✅ · #3 discordância → T6 ✅ · #4 guard preço → T6 ✅ · #5 proxy sem botão → T6 ✅ · #6 cast n_eff → T8 ✅ · P1 #7 nearest-rank → T4 ✅ · #8 preço-acima usa evidência → T6 ✅ · #9 nível recibo → T5 ✅ · #10 banda tolerante → T8 ✅ · P2 #11 guards → T2 ✅ · #12 teste 119,5 → T2 ✅ · #13 paridade objeto inteiro → T8 ✅ · #14 edge cases → T2-6 testes ✅.
**Placeholder scan:** sem TBD; PR3-4 diferidos com escopo. ✅
**Type consistency:** `ReguaPrecoResult` (com observed/suggested/capLimitou/discordancia/reasonCodes) usado consistente T1→T6; assinaturas estáveis. ✅
