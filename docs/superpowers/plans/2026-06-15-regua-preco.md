# Régua de Preço — Implementation Plan (núcleo: helper + RPC + log)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o motor determinístico de benchmark de preço por (cliente, SKU) — helper puro testável + RPC SQL + log closed-loop — que diz "este preço está X% abaixo do custo+imposto / de vendas comparáveis", sem nunca estimar aceite.

**Architecture:** Helper puro TS (`regua-preco-helpers.ts`) é o **oráculo** com todas as fórmulas/gates/hierarquia, testado por vitest (TDD). Uma RPC SQL `get_regua_preco` espelha o helper e busca os comparáveis controlados (mesmo SKU + account=oben + banda de quantidade + 180d + leave-one-customer-out). Uma tabela `regua_preco_log` grava exposição + outcome desde o dia 1. **Zero LLM no número.** A UI (hook + card + integração no carrinho/360) é o **PR3-4, plano separado**, escrito depois do núcleo provado.

**Tech Stack:** TS 5.8 strict · vitest (`bun run test`) · Supabase Postgres (migration via `lovable-db-operator` + prova via `prove-sql-money-path`).

**Premissas confirmadas pelo PR0 (auditoria read-only, ver spec §10.1):** `unit_price` já é líquido (desconto = 0%); janela benchmark = 180d; CMC cobre ~78% via `inventory_position.account ∈ {oben,vendas}`; alíquota de venda = `(icms+pis+cofins)/receita_bruta` de `fin_kpi_tributario` (company oben, mês recente).

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
  precoAtual: number;                 // unit_price no carrinho (líquido — PR0 confirmou desconto=0)
  cmc: number | null;                 // custo médio contábil; null se sem cobertura
  cmcConfiavel: boolean;              // false = proxy (rotular "custo estimado")
  aliquotaVenda: number;              // (icms+pis+cofins)/receita, 0..1
  precosCliente: number[];            // preços recentes que ESTE cliente pagou neste SKU
  comparaveis: { preco: number; clienteId: string }[]; // vendas comparáveis (EXCLUI cliente atual)
  caps: { alta: number; media: number }; // cap de aumento por confiança, ex {alta:0.10, media:0.05}
}

export interface ReguaPrecoResult {
  sinal: TipoSinal;
  confianca: Confianca;
  precoReferencia: number | null;     // alvo sugerido em R$ (null se confiança baixa/oculto)
  gapPct: number | null;              // ref/atual - 1, sempre >= 0
  pisoMC: number | null;              // preço mínimo p/ MC >= 0
  abaixoPiso: boolean;
  recibos: string[];                  // evidência legível
  disclaimers: string[];              // SEMPRE inclui os 2 fixos
}

export const DISCLAIMERS_FIXOS = [
  'Não estimamos aceite do cliente.',
  'Não controlado por prazo de pagamento/frete.',
];
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/regua-preco/types.ts
git commit -m "feat(regua-preco): tipos do motor de benchmark de preço"
```

### Task 2: `percentil` (utilitário base)

**Files:** Create `src/lib/regua-preco/regua-preco-helpers.ts` · Test `src/lib/regua-preco/__tests__/regua-preco-helpers.test.ts`

- [ ] **Step 1: Teste falhando**

```ts
import { describe, it, expect } from 'vitest';
import { percentil } from '../regua-preco-helpers';

describe('percentil', () => {
  it('p65 por interpolação linear', () => {
    expect(percentil([100, 110, 120, 130], 0.65)).toBeCloseTo(119, 0);
  });
  it('lista vazia retorna null', () => {
    expect(percentil([], 0.65)).toBeNull();
  });
  it('um elemento retorna ele mesmo', () => {
    expect(percentil([100], 0.65)).toBe(100);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `bun run test regua-preco` → FAIL (`percentil is not a function`)

- [ ] **Step 3: Implementar**

```ts
/** Percentil por interpolação linear (tipo R-7). Retorna null se vazio. */
export function percentil(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (idx - lo) * (s[hi] - s[lo]);
}
```

- [ ] **Step 4: Rodar e ver passar** — `bun run test regua-preco` → PASS

- [ ] **Step 5: Commit** — `git commit -am "feat(regua-preco): percentil util (TDD)"`

### Task 3: `calcPisoMC` (sinal 🔴, o mais robusto)

**Files:** Modify helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { calcPisoMC } from '../regua-preco-helpers';

describe('calcPisoMC', () => {
  it('piso = cmc / (1 - aliquota)', () => {
    // cmc 98, aliquota 14% → 98/0.86 = 113.95
    expect(calcPisoMC(98, 0.14)).toBeCloseTo(113.95, 2);
  });
  it('cmc null → null (sem cobertura)', () => {
    expect(calcPisoMC(null, 0.14)).toBeNull();
  });
  it('aliquota >= 1 → null (proteção div/0)', () => {
    expect(calcPisoMC(98, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

- [ ] **Step 3: Implementar**

```ts
/** Preço mínimo p/ margem de contribuição >= 0: imposto incide sobre o preço. */
export function calcPisoMC(cmc: number | null, aliquotaVenda: number): number | null {
  if (cmc == null || cmc <= 0) return null;
  if (aliquotaVenda >= 1 || aliquotaVenda < 0) return null;
  return cmc / (1 - aliquotaVenda);
}
```

- [ ] **Step 4: Rodar e ver passar**

- [ ] **Step 5: Commit** — `git commit -am "feat(regua-preco): calcPisoMC (TDD)"`

### Task 4: `calcAutoRef` (sinal 💰 do próprio cliente — cavalo de batalha, 50% cobertura)

**Files:** Modify helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { calcAutoRef } from '../regua-preco-helpers';

describe('calcAutoRef', () => {
  it('p60 dos preços do cliente; confiança alta com >=3 obs', () => {
    const r = calcAutoRef([110, 112, 115]);
    expect(r).not.toBeNull();
    expect(r!.ref).toBeCloseTo(112.6, 1);
    expect(r!.confianca).toBe('alta');
  });
  it('1-2 obs → confiança media', () => {
    expect(calcAutoRef([112])!.confianca).toBe('media');
  });
  it('vazio → null', () => {
    expect(calcAutoRef([])).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

- [ ] **Step 3: Implementar**

```ts
/** Referência do próprio cliente: p60 dos preços recentes que ELE pagou neste SKU. */
export function calcAutoRef(precosCliente: number[]): { ref: number; confianca: Confianca } | null {
  if (precosCliente.length === 0) return null;
  const ref = percentil(precosCliente, 0.6)!;
  const confianca: Confianca = precosCliente.length >= 3 ? 'alta' : 'media';
  return { ref, confianca };
}
```
(import `Confianca` de `./types`)

- [ ] **Step 4: Rodar e ver passar**

- [ ] **Step 5: Commit** — `git commit -am "feat(regua-preco): calcAutoRef (TDD)"`

### Task 5: `calcBenchmark` (sinal 💰 carteira — p65 + n_eff + gates)

**Files:** Modify helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { calcBenchmark } from '../regua-preco-helpers';

describe('calcBenchmark', () => {
  const muitos = (precos: number[], nClientes: number) =>
    precos.map((p, i) => ({ preco: p, clienteId: `c${i % nClientes}` }));

  it('p65 + n_eff; confiança media com n>=15 e n_eff>=5', () => {
    const comp = muitos(Array.from({ length: 16 }, (_, i) => 100 + i), 6);
    const r = calcBenchmark(comp);
    expect(r.pTarget).toBeGreaterThan(108);
    expect(r.nEff).toBeGreaterThanOrEqual(5);
    expect(r.confianca).toBe('media');
  });
  it('SKU concentrado num cliente → n_eff baixo → oculto', () => {
    const comp = Array.from({ length: 20 }, (_, i) => ({ preco: 100 + i, clienteId: i < 18 ? 'c0' : `c${i}` }));
    expect(calcBenchmark(comp).confianca).toBe('oculto');
  });
  it('amostra pequena → oculto', () => {
    expect(calcBenchmark(muitos([100, 110], 2)).confianca).toBe('oculto');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

- [ ] **Step 3: Implementar**

```ts
/** Benchmark da carteira: p65 dos comparáveis + clientes efetivos (n_eff = 1/Σshare²). */
export function calcBenchmark(comparaveis: { preco: number; clienteId: string }[]): {
  pTarget: number | null; n: number; nEff: number; nClientes: number; confianca: Confianca;
} {
  const n = comparaveis.length;
  if (n === 0) return { pTarget: null, n: 0, nEff: 0, nClientes: 0, confianca: 'oculto' };
  const counts = new Map<string, number>();
  for (const c of comparaveis) counts.set(c.clienteId, (counts.get(c.clienteId) ?? 0) + 1);
  const nClientes = counts.size;
  let somaShare2 = 0;
  for (const c of counts.values()) { const s = c / n; somaShare2 += s * s; }
  const nEff = 1 / somaShare2;
  const pTarget = percentil(comparaveis.map((c) => c.preco), 0.65);
  let confianca: Confianca;
  if (n >= 30 && nEff >= 8) confianca = 'alta';
  else if (n >= 15 && nEff >= 5) confianca = 'media';
  else confianca = 'oculto';
  return { pTarget, n, nEff, nClientes, confianca };
}
```

- [ ] **Step 4: Rodar e ver passar**

- [ ] **Step 5: Commit** — `git commit -am "feat(regua-preco): calcBenchmark com n_eff (TDD)"`

### Task 6: `avaliarReguaPreco` (orquestração + hierarquia + cap)

**Files:** Modify helpers + test

- [ ] **Step 1: Teste falhando**

```ts
import { avaliarReguaPreco } from '../regua-preco-helpers';
import { DISCLAIMERS_FIXOS } from '../types';

const base = {
  precoAtual: 106, cmc: 98, cmcConfiavel: true, aliquotaVenda: 0.14,
  precosCliente: [], comparaveis: [], caps: { alta: 0.10, media: 0.05 },
};

describe('avaliarReguaPreco', () => {
  it('🔴 piso vence quando MC negativa', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 106 }); // piso 113.95 > 106
    expect(r.sinal).toBe('piso');
    expect(r.abaixoPiso).toBe(true);
    expect(r.disclaimers).toEqual(expect.arrayContaining(DISCLAIMERS_FIXOS));
  });
  it('auto_ref vence benchmark quando ambos existem e preço acima do piso', () => {
    const r = avaliarReguaPreco({
      ...base, precoAtual: 120, precosCliente: [130, 132, 131],
      comparaveis: Array.from({ length: 16 }, (_, i) => ({ preco: 125 + i, clienteId: `c${i % 6}` })),
    });
    expect(r.sinal).toBe('auto_ref');
    expect(r.precoReferencia).toBeGreaterThan(120);
    expect(r.gapPct! <= base.caps.alta + 1e-9).toBe(true); // cap respeitado
  });
  it('confiança baixa não sugere % (referência null)', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 120, precosCliente: [],
      comparaveis: [{ preco: 130, clienteId: 'c0' }, { preco: 131, clienteId: 'c1' }] });
    expect(r.precoReferencia).toBeNull();
    expect(r.gapPct).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

- [ ] **Step 3: Implementar**

```ts
import { ReguaPrecoInput, ReguaPrecoResult, Confianca, DISCLAIMERS_FIXOS } from './types';

const capDe = (c: Confianca, caps: { alta: number; media: number }) =>
  c === 'alta' ? caps.alta : c === 'media' ? caps.media : 0;

export function avaliarReguaPreco(input: ReguaPrecoInput): ReguaPrecoResult {
  const { precoAtual, cmc, cmcConfiavel, aliquotaVenda, precosCliente, comparaveis, caps } = input;
  const recibos: string[] = [];
  const disclaimers = [...DISCLAIMERS_FIXOS];
  const pisoMC = calcPisoMC(cmc, aliquotaVenda);
  const abaixoPiso = pisoMC != null && precoAtual < pisoMC;

  // 1) Piso de MC vence (mais urgente, maior cobertura)
  if (abaixoPiso) {
    if (!cmcConfiavel) recibos.push('Custo estimado (proxy).');
    recibos.push(`Custo+imposto ≈ piso R$ ${pisoMC!.toFixed(2)}; seu preço R$ ${precoAtual.toFixed(2)} (MC negativa).`);
    return {
      sinal: 'piso', confianca: cmcConfiavel ? 'alta' : 'media',
      precoReferencia: pisoMC, gapPct: pisoMC! / precoAtual - 1,
      pisoMC, abaixoPiso, recibos, disclaimers,
    };
  }

  // 2) Auto-referência do cliente (preferida sobre benchmark)
  const auto = calcAutoRef(precosCliente);
  const bench = calcBenchmark(comparaveis);

  type Cand = { sinal: 'auto_ref' | 'benchmark'; ref: number; confianca: Confianca };
  const cands: Cand[] = [];
  if (auto && auto.ref > precoAtual) cands.push({ sinal: 'auto_ref', ref: auto.ref, confianca: auto.confianca });
  if (bench.pTarget != null && bench.pTarget > precoAtual && bench.confianca !== 'oculto')
    cands.push({ sinal: 'benchmark', ref: bench.pTarget, confianca: bench.confianca });

  if (cands.length === 0)
    return { sinal: 'nenhum', confianca: bench.confianca === 'oculto' ? 'oculto' : 'baixa',
      precoReferencia: null, gapPct: null, pisoMC, abaixoPiso, recibos, disclaimers };

  // auto_ref tem prioridade
  const escolhido = cands.find((c) => c.sinal === 'auto_ref') ?? cands[0];
  const cap = capDe(escolhido.confianca, caps);
  if (cap === 0) { // confiança baixa → recibo sem %
    recibos.push(escolhido.sinal === 'auto_ref'
      ? 'Este cliente já pagou mais neste item (amostra pequena).'
      : 'Vendas comparáveis acima (evidência fraca).');
    return { sinal: escolhido.sinal, confianca: 'baixa', precoReferencia: null, gapPct: null,
      pisoMC, abaixoPiso, recibos, disclaimers };
  }
  const alvo = Math.min(escolhido.ref, precoAtual * (1 + cap));
  const gapPct = Math.max(0, alvo / precoAtual - 1);
  recibos.push(escolhido.sinal === 'auto_ref'
    ? `Você já cobrou ~R$ ${escolhido.ref.toFixed(2)} deste cliente neste item.`
    : `Comparáveis recentes (mesmo porte) no p65: R$ ${escolhido.ref.toFixed(2)}.`);
  if (escolhido.sinal === 'benchmark') disclaimers.push(`Base: ${bench.n} vendas, ${bench.nClientes} clientes, 180d, exclui este cliente.`);
  return { sinal: escolhido.sinal, confianca: escolhido.confianca, precoReferencia: alvo, gapPct,
    pisoMC, abaixoPiso, recibos, disclaimers };
}
```

- [ ] **Step 4: Rodar e ver passar** — `bun run test regua-preco` → todos PASS

- [ ] **Step 5: Typecheck + commit**

```bash
heavy bun run typecheck
git commit -am "feat(regua-preco): avaliarReguaPreco — hierarquia piso>auto_ref>benchmark (TDD)"
```

### Task 7: Falsificação (provar que os testes pegam o erro)

- [ ] **Step 1:** Trocar `precoAtual < pisoMC` por `>` em `avaliarReguaPreco`. Rodar testes → o teste do 🔴 deve **falhar** (vermelho). Reverter.
- [ ] **Step 2:** Trocar `0.65` por `0.95` em `calcBenchmark`. O teste do p65 deve **falhar**. Reverter.
- [ ] **Step 3:** Sem commit (só validação de que a malha de teste morde).

---

## PR2 — RPC SQL + log (ritual da casa)

> **SUB-SKILLS OBRIGATÓRIAS:** `prove-sql-money-path` (provar no PG17 local antes) + `lovable-db-operator` (empacotar o handoff do SQL Editor). É money-path: NÃO entregar migration sem prova executando.

### Task 8: RPC `get_regua_preco`

**Files:** Create `supabase/migrations/<ts>_regua_preco_rpc.sql`

- [ ] **Step 1: Pré-flight** — resolver a **questão aberta do PR0**: rodar via `psql-ro` qual `inventory_position.account` (`oben` vs `vendas`) é canônico pra CMC da Oben (comparar contra `omie_products`/custo conhecido de 3-4 SKUs). Documentar a escolha no topo da migration.

- [ ] **Step 2:** Escrever a RPC `get_regua_preco(p_customer uuid, p_product uuid, p_qty numeric)` SECURITY DEFINER, gate `authorizeCronOrStaff`-equivalente, que retorna as colunas do `ReguaPrecoResult` calculadas em SQL espelhando o helper:
  - `comparaveis` = `order_items ⋈ sales_orders` (account=oben, `order_date_kpi >= now()-180d`, `deleted_at IS NULL`, mesmo `product_id`, **banda de quantidade** por quartil de `log(quantity)` do SKU, `customer_user_id <> p_customer`).
  - `precosCliente` = mesmas vendas, `customer_user_id = p_customer`, 180d.
  - `cmc` ← `inventory_position` (account canônico do Step 1).
  - `aliquotaVenda` ← `(icms+pis+cofins)/receita_bruta_acumulada` de `fin_kpi_tributario` (company oben, mês mais recente).
  - p65/n_eff calculados em SQL (`percentile_cont(0.65)`, `1/sum(share^2)`).

- [ ] **Step 3: PROVAR** — `prove-sql-money-path`: harness PG17, semear comparáveis (incl. caso SKU-concentrado e caso MC-negativa), assertar que o `sinal`/`pTarget`/`abaixoPiso` batem com o helper TS (mesmos inputs → mesmo veredito), **falsificar** (sabotar o filtro `customer_user_id <>` → exigir que o teste de leave-one-out fique vermelho).

- [ ] **Step 4: Handoff** — `lovable-db-operator`: gerar bloco do SQL Editor + query de validação pós-apply + nota de PR.

### Task 9: Tabela `regua_preco_log`

**Files:** Create `supabase/migrations/<ts>_regua_preco_log.sql`

- [ ] **Step 1:** Tabela com os campos do spec §8 (id, created_at, account, customer_user_id, product_id, salesperson_id, sales_order_id, quantity, preco_atual, ref_cliente, p_target_benchmark, piso_mc, sinal_exibido, gap_sugerido_pct, confianca, preco_final, aplicou_bool, outcome_status, outcome_at, cmc_usado, cmc_confianca, aliquota_usada, evidence_version, reason_codes).
- [ ] **Step 2:** RLS: `SELECT/INSERT` para staff; `customer` sem acesso. Tabela nova **sempre** com RLS (gate na fronteira).
- [ ] **Step 3: PROVAR** — `prove-sql-money-path`: RLS sob `SET ROLE authenticated` + GUC (vendedor insere o próprio log; customer não lê). Falsificar (remover a policy → exigir vermelho).
- [ ] **Step 4: Handoff** — `lovable-db-operator`.

---

## PR3-PR4 — UI (plano separado, após o núcleo provado)

Fora deste plano por dependerem do shape final do `ReguaPrecoResult` provado e de componentes existentes do `unified-order`. Escopo (vira plano próprio):
- **PR3:** `useReguaPreco` (react-query) + `ReguaPrecoCard` (modos 🔴/💰, copy do spec §6, disclaimers no ⓘ) + integração no carrinho `unified-order` + feature flag `regua_preco_carrinho` (sombra→balcão) + gravação no `regua_preco_log`.
- **PR4:** card no `Customer360` (reuso do `ReguaPrecoCard`).

---

## Self-Review

**Spec coverage:** §3 sinais → Tasks 3-6 ✅ · §4 fórmulas → Tasks 2-6 ✅ · §5 confiança → Tasks 4-6 ✅ · §8 log → Task 9 ✅ · §10.1 premissas PR0 → premissas do header + Task 8 ✅ · §6 copy/UI → PR3 (plano separado, declarado) ✅.
**Placeholder scan:** sem TBD; PR3-4 explicitamente diferidos com escopo, não placeholder. ✅
**Type consistency:** `ReguaPrecoResult`/`Confianca`/`TipoSinal` usados de forma consistente das Tasks 1→6; `calcPisoMC`/`calcAutoRef`/`calcBenchmark`/`avaliarReguaPreco` com assinaturas estáveis. ✅
