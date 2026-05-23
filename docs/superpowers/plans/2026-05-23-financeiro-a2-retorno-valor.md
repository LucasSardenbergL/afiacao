# Financeiro A2 — Retorno & Valor (ROIC / WACC / EVA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a camada de retorno sobre capital (NOPAT regime-aware, capital investido, WACC hurdle-rate, ROIC, EVA, spread e ROIC incremental) por empresa, com normalização de comingling do dono e degradação honesta, pra apoiar a decisão de "onde colocar o próximo R$1" entre Colacor / Oben / Colacor SC.

**Architecture:** Helper puro testável (`src/lib/financeiro/valor-helpers.ts`, vitest) espelhado verbatim numa **edge function Deno dedicada** (`fin-valor-engine`) que lê DRE TTM (`fin_dre_snapshots`) + NCG (`fin_projecao_snapshots.ncg`) + inputs manuais (`fin_config_cashflow.valor_inputs`, JSONB opcional) e devolve um bloco "valor" por empresa. Frontend: hook `useValor` (invoca a function, igual `useCashflowProjection`) + página `/financeiro/valor` (master-only) com cards/ranking/toggle reportado×normalizado/banner de confiança/formulário dos inputs. Zero alteração no `fin-cashflow-engine`/`omie-financeiro` de produção (DoD: A2 não regride Ondas 1-3).

**Tech Stack:** React 18 + TS + Vite + react-router + @tanstack/react-query + shadcn/ui + Tailwind (tokens status-*) no front; Supabase Edge Function Deno + Postgres no back; vitest pros helpers; `deno check` pro engine.

---

## ⚠️ Correções aprovadas pós-Codex (2026-05-23) — sobrepõem o texto literal do spec

O consult Codex (com o código real do `montarDRE` em mãos) pegou um furo de double-count e um ponto de pureza do EBIT. **O founder aprovou as 3 correções abaixo via AskUserQuestion.** Onde este plano divergir do texto literal do spec §2, **vale este plano**:

1. **NOPAT — só impostos abaixo da linha operacional.** No `montarDRE` o `resultado_operacional` JÁ está líquido das deduções (presumido: PIS/COFINS/ICMS/ISS/IPI; Simples: DAS). Subtrair de novo é double-count. Correto:
   - **Presumido:** `NOPAT = EBIT − (IRPJ + CSLL)`
   - **Simples:** `NOPAT = EBIT` (DAS já absorvido acima)
   - A **carga tributária total do regime** é exibida à parte (transparência), **nunca** re-subtraída do NOPAT.
2. **EBIT operacional puro pro ROIC.** O `resultado_operacional` da DRE inclui `+ receitas_financeiras − despesas_financeiras`. Pro ROIC o EBIT deve ser só operacional. Correto: `EBIT = resultado_operacional − receitas_financeiras + despesas_financeiras`.
3. **Sem clamp no NOPAT.** Deixar NOPAT negativo honestamente. O que o spec queria evitar era o multiplicador `(1−t)` (transforma prejuízo em "benefício fiscal"), não o NOPAT negativo. Usar imposto absoluto e permitir negativo.

Tudo o mais do spec (`docs/superpowers/specs/2026-05-23-financeiro-a2-retorno-valor-design.md`) permanece a fonte da verdade.

---

## Estado do repositório / branch

- O worktree atual (`claude/exciting-wilbur-199192`) está em `cb92126`, que é o **main efetivo de produção** (tem Ondas 1-3 + fixes #195). A ref `main`/`origin/main` local está stale em `baf00bd` — **NÃO branchar de `main`**; branchar do HEAD atual (`cb92126`).
- O spec da A2 vive no commit `bdf4a63` (= `cb92126` + o doc). Task 0 traz o doc pra branch de implementação.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
| --- | --- | --- |
| `src/lib/financeiro/valor-helpers.ts` | Funções puras: NOPAT, margem, capital investido, WACC, ROIC/EVA/spread, incremental, comingling, confiança. Sem deps de runtime. | Criar |
| `src/lib/financeiro/__tests__/valor-helpers.test.ts` | Testes vitest dos helpers. | Criar |
| `supabase/functions/fin-valor-engine/index.ts` | Edge function Deno dedicada (master-only). Espelha os helpers verbatim + lê DRE TTM/NCG/valor_inputs e devolve o bloco valor por empresa. | Criar |
| `src/services/financeiroService.ts` | Tipos `ValorInputs`, `ValorEmpresaResult` (contrato com o engine). | Modificar |
| `src/hooks/useValor.ts` | Hook react-query `useValor(company)` (invoca a function) + `useUpdateValorInputs()` (grava `valor_inputs`). | Criar |
| `src/pages/FinanceiroValor.tsx` | Página `/financeiro/valor` (master-only): cards por empresa, ranking por ROIC incremental + spread, toggle reportado×normalizado, banner de confiança, dialog do formulário dos inputs. | Criar |
| `src/components/financeiro/ValorInputsDialog.tsx` | Dialog do formulário dos inputs manuais (master). | Criar |
| `src/App.tsx` | Lazy import + rota `financeiro/valor`. | Modificar |
| `src/components/AppShell.tsx` | Link "Retorno & Valor" na seção Financeiro (sidebar), master-only. | Modificar |
| `docs/FINANCEIRO_CONFIABILIDADE.md` | Seção A2 (após Onda 3b). | Modificar |
| SQL (entregue ao founder, não migration obrigatória) | `ALTER TABLE fin_config_cashflow ADD COLUMN IF NOT EXISTS valor_inputs jsonb NOT NULL DEFAULT '{}'`. | Entregar inline |

---

## Contrato de tipos (referência única — usar EXATAMENTE estes nomes em todas as tasks)

Definidos na Task 1 (`valor-helpers.ts`) e espelhados no engine/serviço:

```ts
// Reusa de dre-helpers
type RegimeTributario = 'simples' | 'presumido';

type NopatInput = {
  regime: RegimeTributario;
  resultado_operacional_ttm: number;
  receitas_financeiras_ttm: number;
  despesas_financeiras_ttm: number;
  irpj_ttm: number; csll_ttm: number;
  das_ttm: number; pis_ttm: number; cofins_ttm: number; icms_ttm: number; iss_ttm: number; ipi_ttm: number;
};
type NopatResult = { ebit: number; imposto_operacional_nopat: number; nopat: number; carga_tributaria_regime_total: number };

type AtivoFixoInput = { valor: number; data_ref: string | null; fonte: 'book'|'avaliacao'|'reposicao'|'seguro'|null; base: 'reposicao'|'book'|null; operacional: boolean } | null;
type CapitalInvestidoResult = { capital_investido: number; capital_giro: number; ativo_fixo: number; ajustes: number; parcial: boolean; motivos: string[] };

type KeDecomposto = { ancora: number; premio_risco_equity: number; premio_tamanho_private: number; premio_iliquidez_controle: number };
type WaccResult = { wacc: number | null; ke: number | null; kd: number | null; peso_divida: number | null; peso_equity: number | null; tax_shield_aplicado: false; motivos: string[] };

type RoicIncrementalResult = { roic_incremental: number | null; delta_nopat: number | null; delta_capital: number | null; aviso: string | null };
type CominglingResult = { ebit_reportado: number; ebit_normalizado: number; capital_reportado: number; capital_normalizado: number; ajuste_prolabore: number; ajuste_aluguel: number; ajuste_intercompany_capital: number; aplicado: boolean; motivos: string[] };
type ConfiancaValor = { nivel: 'alta'|'media'|'baixa'; motivos: string[]; roic_disponivel: boolean; wacc_disponivel: boolean; eva_disponivel: boolean; normalizado_disponivel: boolean };
```

---

## Task 0: Branch + trazer o spec

**Files:**
- Create branch `feat/financeiro-a2-impl` from current HEAD
- Copy: `docs/superpowers/specs/2026-05-23-financeiro-a2-retorno-valor-design.md`

- [ ] **Step 1: Criar a branch do HEAD atual (NÃO de `main`, que está stale)**

```bash
git checkout -b feat/financeiro-a2-impl
git rev-parse --short HEAD   # deve ser cb92126
```

- [ ] **Step 2: Trazer o doc do spec pra branch (cherry-pick do commit que só adiciona o doc)**

```bash
git cherry-pick --no-commit bdf4a63
git status   # deve mostrar só docs/superpowers/specs/2026-05-23-financeiro-a2-retorno-valor-design.md
```

Se o cherry-pick conflitar (não deve, pai = cb92126), abortar e copiar o arquivo manualmente via `git show bdf4a63:docs/superpowers/specs/2026-05-23-financeiro-a2-retorno-valor-design.md`.

- [ ] **Step 3: Garantir que o plano está commitável (já salvo por este processo)**

O plano (`docs/superpowers/plans/2026-05-23-financeiro-a2-retorno-valor.md`) e o spec ficam staged. **NÃO commitar ainda** — o founder commita/autoriza. Seguir pra Task 1.

---

## Task 1: Tipos + `calcularNOPAT`

**Files:**
- Create: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/financeiro/__tests__/valor-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { calcularNOPAT } from '../valor-helpers';

describe('calcularNOPAT', () => {
  it('presumido: NOPAT = EBIT puro − (IRPJ+CSLL); não subtrai PIS/COFINS de novo', () => {
    const r = calcularNOPAT({
      regime: 'presumido',
      resultado_operacional_ttm: 1000, // inclui +recfin −despfin
      receitas_financeiras_ttm: 100,
      despesas_financeiras_ttm: 40,
      irpj_ttm: 90, csll_ttm: 30,
      das_ttm: 0, pis_ttm: 13, cofins_ttm: 60, icms_ttm: 0, iss_ttm: 0, ipi_ttm: 0,
    });
    // EBIT puro = 1000 − 100 + 40 = 940
    expect(r.ebit).toBe(940);
    // imposto abaixo da linha = 90 + 30 = 120 (PIS/COFINS NÃO entram)
    expect(r.imposto_operacional_nopat).toBe(120);
    expect(r.nopat).toBe(820);
    // carga total do regime (informacional) = irpj+csll+pis+cofins+icms+iss+ipi
    expect(r.carga_tributaria_regime_total).toBe(90 + 30 + 13 + 60);
  });

  it('simples: NOPAT = EBIT puro (DAS já absorvido); imposto abaixo da linha = 0', () => {
    const r = calcularNOPAT({
      regime: 'simples',
      resultado_operacional_ttm: 500,
      receitas_financeiras_ttm: 20,
      despesas_financeiras_ttm: 10,
      irpj_ttm: 0, csll_ttm: 0,
      das_ttm: 80, pis_ttm: 0, cofins_ttm: 0, icms_ttm: 0, iss_ttm: 0, ipi_ttm: 0,
    });
    expect(r.ebit).toBe(490); // 500 − 20 + 10
    expect(r.imposto_operacional_nopat).toBe(0);
    expect(r.nopat).toBe(490);
    expect(r.carga_tributaria_regime_total).toBe(80); // DAS, informacional
  });

  it('EBIT negativo → NOPAT negativo (sem clamp, sem multiplicador)', () => {
    const r = calcularNOPAT({
      regime: 'presumido', resultado_operacional_ttm: -200,
      receitas_financeiras_ttm: 0, despesas_financeiras_ttm: 0,
      irpj_ttm: 0, csll_ttm: 0, das_ttm: 0, pis_ttm: 0, cofins_ttm: 0, icms_ttm: 0, iss_ttm: 0, ipi_ttm: 0,
    });
    expect(r.nopat).toBe(-200);
  });

  it('imposto > EBIT → NOPAT negativo coerente (presumido)', () => {
    const r = calcularNOPAT({
      regime: 'presumido', resultado_operacional_ttm: 100,
      receitas_financeiras_ttm: 0, despesas_financeiras_ttm: 0,
      irpj_ttm: 90, csll_ttm: 40, das_ttm: 0, pis_ttm: 0, cofins_ttm: 0, icms_ttm: 0, iss_ttm: 0, ipi_ttm: 0,
    });
    expect(r.nopat).toBe(-30); // 100 − 130
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `bun run test -- valor-helpers`
Expected: FAIL — `calcularNOPAT is not a function` / módulo não existe.

- [ ] **Step 3: Implementação mínima**

```ts
// src/lib/financeiro/valor-helpers.ts
// A2 — Retorno & Valor (ROIC/WACC/EVA). Módulo puro (sem deps de runtime),
// espelhado verbatim na edge function Deno supabase/functions/fin-valor-engine/index.ts.
// Correções pós-Codex (2026-05-23): NOPAT subtrai só impostos ABAIXO da linha (presumido: IRPJ+CSLL;
// simples: 0 — DAS já está nas deduções); EBIT operacional PURO (sem resultado financeiro); sem clamp.

import type { RegimeTributario } from './dre-helpers';

export type { RegimeTributario };

export type NopatInput = {
  regime: RegimeTributario;
  resultado_operacional_ttm: number;   // EBIT bruto da DRE (inclui +recfin −despfin)
  receitas_financeiras_ttm: number;
  despesas_financeiras_ttm: number;
  irpj_ttm: number;
  csll_ttm: number;
  // carga indireta já absorvida ACIMA do EBIT (só informacional, nunca re-subtraída):
  das_ttm: number;
  pis_ttm: number;
  cofins_ttm: number;
  icms_ttm: number;
  iss_ttm: number;
  ipi_ttm: number;
};

export type NopatResult = {
  ebit: number;
  imposto_operacional_nopat: number;
  nopat: number;
  carga_tributaria_regime_total: number;
};

export function calcularNOPAT(input: NopatInput): NopatResult {
  // EBIT operacional PURO: remove o resultado financeiro embutido no resultado_operacional da DRE.
  const ebit =
    input.resultado_operacional_ttm - input.receitas_financeiras_ttm + input.despesas_financeiras_ttm;
  // Só impostos ABAIXO da linha operacional. Indiretos (presumido) e DAS (simples) já saíram nas deduções.
  const imposto_operacional_nopat = input.regime === 'presumido' ? input.irpj_ttm + input.csll_ttm : 0;
  // Sem clamp: NOPAT pode ser negativo honestamente.
  const nopat = ebit - imposto_operacional_nopat;
  const carga_tributaria_regime_total =
    input.regime === 'simples'
      ? input.das_ttm
      : input.irpj_ttm + input.csll_ttm + input.pis_ttm + input.cofins_ttm + input.icms_ttm + input.iss_ttm + input.ipi_ttm;
  return { ebit, imposto_operacional_nopat, nopat, carga_tributaria_regime_total };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-helpers`
Expected: PASS (4 testes de `calcularNOPAT`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-helpers.ts src/lib/financeiro/__tests__/valor-helpers.test.ts
git commit -m "feat(financeiro a2): calcularNOPAT regime-aware (EBIT puro − imposto abaixo da linha)"
```

---

## Task 2: `margemOperacionalPreImposto`

**Files:**
- Modify: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { margemOperacionalPreImposto } from '../valor-helpers';

describe('margemOperacionalPreImposto', () => {
  it('EBIT / receita_liquida', () => {
    expect(margemOperacionalPreImposto({ ebit: 200, receita_liquida: 1000 })).toBeCloseTo(0.2, 10);
  });
  it('receita_liquida 0 → 0', () => {
    expect(margemOperacionalPreImposto({ ebit: 200, receita_liquida: 0 })).toBe(0);
  });
  it('receita_liquida negativa → 0 (guarda)', () => {
    expect(margemOperacionalPreImposto({ ebit: 200, receita_liquida: -50 })).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-helpers`
Expected: FAIL — `margemOperacionalPreImposto is not a function`.

- [ ] **Step 3: Implementar (append em `valor-helpers.ts`)**

```ts
export function margemOperacionalPreImposto(input: { ebit: number; receita_liquida: number }): number {
  if (input.receita_liquida <= 0) return 0;
  return input.ebit / input.receita_liquida;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-helpers.ts src/lib/financeiro/__tests__/valor-helpers.test.ts
git commit -m "feat(financeiro a2): margemOperacionalPreImposto"
```

---

## Task 3: `capitalInvestido`

**Files:**
- Modify: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { capitalInvestido } from '../valor-helpers';

describe('capitalInvestido', () => {
  it('giro + ativo fixo − ajustes; completo (não parcial)', () => {
    const r = capitalInvestido({
      capital_giro: 300000,
      ativo_fixo: { valor: 500000, data_ref: '2026-01-01', fonte: 'reposicao', base: 'reposicao', operacional: true },
      ajustes: 20000,
    });
    expect(r.capital_investido).toBe(780000); // 300k + 500k − 20k
    expect(r.parcial).toBe(false);
    expect(r.ativo_fixo).toBe(500000);
  });

  it('sem ativo fixo → parcial (só giro − ajustes) + motivo', () => {
    const r = capitalInvestido({ capital_giro: 300000, ativo_fixo: null });
    expect(r.capital_investido).toBe(300000);
    expect(r.ativo_fixo).toBe(0);
    expect(r.parcial).toBe(true);
    expect(r.motivos.length).toBeGreaterThan(0);
  });

  it('ativo fixo marcado como não-operacional → não entra, vira parcial', () => {
    const r = capitalInvestido({
      capital_giro: 100,
      ativo_fixo: { valor: 999, data_ref: null, fonte: 'book', base: 'book', operacional: false },
    });
    expect(r.ativo_fixo).toBe(0);
    expect(r.parcial).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-helpers`
Expected: FAIL — `capitalInvestido is not a function`.

- [ ] **Step 3: Implementar (append)**

```ts
export type AtivoFixoInput = {
  valor: number;
  data_ref: string | null;
  fonte: 'book' | 'avaliacao' | 'reposicao' | 'seguro' | null;
  base: 'reposicao' | 'book' | null;
  operacional: boolean;
} | null;

export type CapitalInvestidoResult = {
  capital_investido: number;
  capital_giro: number;
  ativo_fixo: number;
  ajustes: number;
  parcial: boolean;
  motivos: string[];
};

export function capitalInvestido(input: {
  capital_giro: number;
  ativo_fixo: AtivoFixoInput;
  ajustes?: number;
}): CapitalInvestidoResult {
  const ajustes = input.ajustes ?? 0;
  const motivos: string[] = [];
  let ativo_fixo = 0;
  let parcial = false;
  if (input.ativo_fixo && input.ativo_fixo.operacional && Number.isFinite(input.ativo_fixo.valor)) {
    ativo_fixo = input.ativo_fixo.valor;
  } else {
    parcial = true;
    motivos.push('Ativo fixo operacional não informado — capital investido parcial (só giro − ajustes).');
  }
  const capital_investido = input.capital_giro + ativo_fixo - ajustes;
  return { capital_investido, capital_giro: input.capital_giro, ativo_fixo, ajustes, parcial, motivos };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-helpers.ts src/lib/financeiro/__tests__/valor-helpers.test.ts
git commit -m "feat(financeiro a2): capitalInvestido (giro + ativo fixo manual − ajustes; parcial sem AF)"
```

---

## Task 4: `somarKe` + `waccHurdle`

**Files:**
- Modify: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { somarKe, waccHurdle } from '../valor-helpers';

describe('somarKe', () => {
  it('Ke = âncora + Σ prêmios', () => {
    expect(somarKe({ ancora: 0.11, premio_risco_equity: 0.05, premio_tamanho_private: 0.03, premio_iliquidez_controle: 0.02 }))
      .toBeCloseTo(0.21, 10);
  });
});

describe('waccHurdle', () => {
  it('pesos + Kd PRÉ-imposto (tax-shield off); wacc = we·Ke + wd·Kd', () => {
    const r = waccHurdle({ ke: 0.20, kd: 0.14, divida: 400000, equity: 600000 });
    // wd = 0.4, we = 0.6 → 0.6*0.20 + 0.4*0.14 = 0.12 + 0.056 = 0.176
    expect(r.peso_divida).toBeCloseTo(0.4, 10);
    expect(r.peso_equity).toBeCloseTo(0.6, 10);
    expect(r.wacc).toBeCloseTo(0.176, 10);
    expect(r.tax_shield_aplicado).toBe(false);
  });

  it('sem dívida (divida=0) → wacc = Ke (all-equity)', () => {
    const r = waccHurdle({ ke: 0.18, kd: null, divida: 0, equity: 500000 });
    expect(r.wacc).toBeCloseTo(0.18, 10);
  });

  it('Ke ausente → wacc null + motivo', () => {
    const r = waccHurdle({ ke: null, kd: 0.1, divida: 100, equity: 100 });
    expect(r.wacc).toBeNull();
    expect(r.motivos.length).toBeGreaterThan(0);
  });

  it('PL ausente → wacc null', () => {
    expect(waccHurdle({ ke: 0.2, kd: 0.1, divida: 100, equity: null }).wacc).toBeNull();
  });

  it('há dívida mas Kd ausente → wacc null', () => {
    expect(waccHurdle({ ke: 0.2, kd: null, divida: 100, equity: 100 }).wacc).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-helpers`
Expected: FAIL — `somarKe is not a function`.

- [ ] **Step 3: Implementar (append)**

```ts
export type KeDecomposto = {
  ancora: number;
  premio_risco_equity: number;
  premio_tamanho_private: number;
  premio_iliquidez_controle: number;
};

export function somarKe(d: KeDecomposto): number {
  return d.ancora + d.premio_risco_equity + d.premio_tamanho_private + d.premio_iliquidez_controle;
}

export type WaccResult = {
  wacc: number | null;
  ke: number | null;
  kd: number | null;
  peso_divida: number | null;
  peso_equity: number | null;
  tax_shield_aplicado: false; // sempre false: tax-shield desligado por regime (Simples/Presumido)
  motivos: string[];
};

export function waccHurdle(input: {
  ke: number | null;
  kd: number | null;
  divida: number | null;
  equity: number | null;
}): WaccResult {
  const motivos: string[] = [];
  const base: WaccResult = {
    wacc: null, ke: input.ke, kd: input.kd, peso_divida: null, peso_equity: null,
    tax_shield_aplicado: false, motivos,
  };
  if (input.ke == null) { motivos.push('Ke não informado — WACC indisponível.'); return base; }
  if (input.equity == null) { motivos.push('PL (equity) não informado — WACC indisponível.'); return base; }
  if (input.divida == null) { motivos.push('Dívida não informada — WACC indisponível.'); return base; }
  const total = input.divida + input.equity;
  if (total <= 0) { motivos.push('Dívida + PL ≤ 0 — WACC indisponível.'); return base; }
  if (input.divida > 0 && input.kd == null) { motivos.push('Há dívida mas Kd não informado — WACC indisponível.'); return base; }
  const peso_divida = input.divida / total;
  const peso_equity = 1 - peso_divida;
  const kd = input.kd ?? 0;
  // Kd PRÉ-imposto: sem ×(1−t). Tax-shield ≈ 0 nos dois regimes.
  const wacc = peso_equity * input.ke + peso_divida * kd;
  return { wacc, ke: input.ke, kd: input.kd, peso_divida, peso_equity, tax_shield_aplicado: false, motivos };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-helpers.ts src/lib/financeiro/__tests__/valor-helpers.test.ts
git commit -m "feat(financeiro a2): somarKe + waccHurdle (Ke decomposto, Kd pré-imposto, indisponível sem inputs)"
```

---

## Task 5: `roic` + `spread` + `eva`

**Files:**
- Modify: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { roic, spread, eva } from '../valor-helpers';

describe('roic / spread / eva', () => {
  it('roic = nopat / capital', () => {
    expect(roic({ nopat: 200, capital_investido: 1000 })).toBeCloseTo(0.2, 10);
  });
  it('roic: capital 0 ou null → null', () => {
    expect(roic({ nopat: 200, capital_investido: 0 })).toBeNull();
    expect(roic({ nopat: 200, capital_investido: null })).toBeNull();
  });
  it('spread = roic − wacc; qualquer null → null', () => {
    expect(spread({ roic: 0.2, wacc: 0.176 })).toBeCloseTo(0.024, 10);
    expect(spread({ roic: null, wacc: 0.1 })).toBeNull();
    expect(spread({ roic: 0.2, wacc: null })).toBeNull();
  });
  it('eva = spread × capital; qualquer null → null', () => {
    expect(eva({ spread: 0.024, capital_investido: 1000 })).toBeCloseTo(24, 10);
    expect(eva({ spread: null, capital_investido: 1000 })).toBeNull();
    expect(eva({ spread: 0.024, capital_investido: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-helpers`
Expected: FAIL — `roic is not a function`.

- [ ] **Step 3: Implementar (append)**

```ts
export function roic(input: { nopat: number; capital_investido: number | null }): number | null {
  if (input.capital_investido == null || input.capital_investido <= 0) return null;
  return input.nopat / input.capital_investido;
}

export function spread(input: { roic: number | null; wacc: number | null }): number | null {
  if (input.roic == null || input.wacc == null) return null;
  return input.roic - input.wacc;
}

export function eva(input: { spread: number | null; capital_investido: number | null }): number | null {
  if (input.spread == null || input.capital_investido == null) return null;
  return input.spread * input.capital_investido;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-helpers.ts src/lib/financeiro/__tests__/valor-helpers.test.ts
git commit -m "feat(financeiro a2): roic + spread + eva (null-safe)"
```

---

## Task 6: `roicIncremental`

**Files:**
- Modify: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { roicIncremental } from '../valor-helpers';

describe('roicIncremental', () => {
  it('ΔNOPAT / Δcapital quando Δcapital ≥ limiar', () => {
    const r = roicIncremental({ nopat_atual: 300, nopat_anterior: 200, capital_atual: 1500000, capital_anterior: 1000000, limiar_delta_capital: 1000 });
    expect(r.delta_nopat).toBe(100);
    expect(r.delta_capital).toBe(500000);
    expect(r.roic_incremental).toBeCloseTo(100 / 500000, 12);
    expect(r.aviso).toBeNull();
  });

  it('Δcapital pequeno (< limiar) → null + aviso', () => {
    const r = roicIncremental({ nopat_atual: 300, nopat_anterior: 200, capital_atual: 1000500, capital_anterior: 1000000, limiar_delta_capital: 1000 });
    expect(r.roic_incremental).toBeNull();
    expect(r.aviso).not.toBeNull();
  });

  it('Δcapital negativo → null + aviso (desinvestimento é ruído)', () => {
    const r = roicIncremental({ nopat_atual: 300, nopat_anterior: 200, capital_atual: 900000, capital_anterior: 1000000, limiar_delta_capital: 1000 });
    expect(r.roic_incremental).toBeNull();
    expect(r.aviso).not.toBeNull();
  });

  it('histórico ausente (anterior null) → null + aviso', () => {
    const r = roicIncremental({ nopat_atual: 300, nopat_anterior: null, capital_atual: 1500000, capital_anterior: null });
    expect(r.roic_incremental).toBeNull();
    expect(r.delta_nopat).toBeNull();
    expect(r.aviso).not.toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-helpers`
Expected: FAIL — `roicIncremental is not a function`.

- [ ] **Step 3: Implementar (append)**

```ts
export type RoicIncrementalResult = {
  roic_incremental: number | null;
  delta_nopat: number | null;
  delta_capital: number | null;
  aviso: string | null;
};

export function roicIncremental(input: {
  nopat_atual: number;
  nopat_anterior: number | null;
  capital_atual: number | null;
  capital_anterior: number | null;
  limiar_delta_capital?: number;
}): RoicIncrementalResult {
  const limiar = input.limiar_delta_capital ?? 1000;
  if (input.nopat_anterior == null || input.capital_atual == null || input.capital_anterior == null) {
    return {
      roic_incremental: null, delta_nopat: null, delta_capital: null,
      aviso: 'Histórico insuficiente (precisa de NOPAT e capital do TTM atual e do TTM −12m).',
    };
  }
  const delta_nopat = input.nopat_atual - input.nopat_anterior;
  const delta_capital = input.capital_atual - input.capital_anterior;
  if (delta_capital < limiar) {
    return {
      roic_incremental: null, delta_nopat, delta_capital,
      aviso: 'Variação de capital pequena ou negativa — ROIC incremental seria ruído.',
    };
  }
  return { roic_incremental: delta_nopat / delta_capital, delta_nopat, delta_capital, aviso: null };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-helpers.ts src/lib/financeiro/__tests__/valor-helpers.test.ts
git commit -m "feat(financeiro a2): roicIncremental (headline; degrada com aviso em Δcapital pequeno/negativo)"
```

---

## Task 7: `normalizarComingling`

**Files:**
- Modify: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

> Nota de implementação: o spec §6 lista `prolabore_mercado_mensal`. Pra computar o ajuste sem fabricar, o helper recebe TAMBÉM o pró-labore real (TTM) — ambos viram inputs manuais (o dono conhece os dois). A anualização (×12 do mensal) acontece no engine; o helper opera em TTM.

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { normalizarComingling } from '../valor-helpers';

describe('normalizarComingling', () => {
  it('dono se paga ABAIXO do mercado → EBIT normalizado MENOR que o reportado', () => {
    const r = normalizarComingling({
      ebit_reportado: 1000, capital_reportado: 500000,
      prolabore_real_ttm: 120000, prolabore_mercado_ttm: 200000, // paga 120k, mercado 200k
      aluguel_mercado_ttm: null, intercompany_giro: null,
    });
    // ajuste = real − mercado = 120k − 200k = −80k → ebit_norm = 1000 − 80000 = −79000
    expect(r.ajuste_prolabore).toBe(-80000);
    expect(r.ebit_normalizado).toBe(-79000);
    expect(r.aplicado).toBe(true);
    expect(r.ebit_normalizado).not.toBe(r.ebit_reportado);
  });

  it('aluguel de mercado reduz EBIT (despesa figurativa)', () => {
    const r = normalizarComingling({
      ebit_reportado: 500000, capital_reportado: 500000,
      prolabore_real_ttm: null, prolabore_mercado_ttm: null,
      aluguel_mercado_ttm: 60000, intercompany_giro: null,
    });
    expect(r.ajuste_aluguel).toBe(-60000);
    expect(r.ebit_normalizado).toBe(440000);
  });

  it('intercompany removido do capital de giro no normalizado', () => {
    const r = normalizarComingling({
      ebit_reportado: 100, capital_reportado: 800000,
      prolabore_real_ttm: null, prolabore_mercado_ttm: null,
      aluguel_mercado_ttm: null, intercompany_giro: 150000,
    });
    expect(r.ajuste_intercompany_capital).toBe(-150000);
    expect(r.capital_normalizado).toBe(650000);
  });

  it('sem nenhum input de normalização → aplicado=false e normalizado == reportado', () => {
    const r = normalizarComingling({
      ebit_reportado: 100, capital_reportado: 200,
      prolabore_real_ttm: null, prolabore_mercado_ttm: null,
      aluguel_mercado_ttm: null, intercompany_giro: null,
    });
    expect(r.aplicado).toBe(false);
    expect(r.ebit_normalizado).toBe(100);
    expect(r.capital_normalizado).toBe(200);
    expect(r.motivos.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-helpers`
Expected: FAIL — `normalizarComingling is not a function`.

- [ ] **Step 3: Implementar (append)**

```ts
export type CominglingResult = {
  ebit_reportado: number;
  ebit_normalizado: number;
  capital_reportado: number;
  capital_normalizado: number;
  ajuste_prolabore: number;
  ajuste_aluguel: number;
  ajuste_intercompany_capital: number;
  aplicado: boolean;
  motivos: string[];
};

export function normalizarComingling(input: {
  ebit_reportado: number;
  capital_reportado: number;
  prolabore_real_ttm: number | null;
  prolabore_mercado_ttm: number | null;
  aluguel_mercado_ttm: number | null;
  intercompany_giro: number | null;
}): CominglingResult {
  const motivos: string[] = [];
  let aplicado = false;

  // Pró-labore: EBIT reportado já deduziu o pró-labore REAL. Normalizar p/ mercado:
  // ebit_norm = ebit_rep + (real − mercado). Dono que se paga abaixo do mercado infla o lucro reportado.
  let ajuste_prolabore = 0;
  if (input.prolabore_real_ttm != null && input.prolabore_mercado_ttm != null) {
    ajuste_prolabore = input.prolabore_real_ttm - input.prolabore_mercado_ttm;
    aplicado = true;
  } else {
    motivos.push('Pró-labore real/mercado não informado — sem normalização de pró-labore.');
  }

  // Aluguel de mercado de ativos do dono usados sem cobrança: despesa figurativa → reduz EBIT.
  let ajuste_aluguel = 0;
  if (input.aluguel_mercado_ttm != null) {
    ajuste_aluguel = -input.aluguel_mercado_ttm;
    aplicado = true;
  } else {
    motivos.push('Aluguel de mercado não informado — sem normalização de aluguel.');
  }

  // Intercompany dentro do giro: removido do capital no normalizado.
  let ajuste_intercompany_capital = 0;
  if (input.intercompany_giro != null) {
    ajuste_intercompany_capital = -input.intercompany_giro;
    aplicado = true;
  }

  const ebit_normalizado = input.ebit_reportado + ajuste_prolabore + ajuste_aluguel;
  const capital_normalizado = input.capital_reportado + ajuste_intercompany_capital;
  if (!aplicado) motivos.push('Sem inputs de normalização — só visão reportada; possível comingling do dono não ajustado.');

  return {
    ebit_reportado: input.ebit_reportado,
    ebit_normalizado,
    capital_reportado: input.capital_reportado,
    capital_normalizado,
    ajuste_prolabore,
    ajuste_aluguel,
    ajuste_intercompany_capital,
    aplicado,
    motivos,
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-helpers.ts src/lib/financeiro/__tests__/valor-helpers.test.ts
git commit -m "feat(financeiro a2): normalizarComingling (pró-labore/aluguel/intercompany; reportado vs normalizado)"
```

---

## Task 8: `scoreConfiancaValor`

**Files:**
- Modify: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { scoreConfiancaValor } from '../valor-helpers';

describe('scoreConfiancaValor', () => {
  it('tudo presente + DRE alta → alta', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
    });
    expect(r.nivel).toBe('alta');
    expect(r.wacc_disponivel).toBe(true);
    expect(r.normalizado_disponivel).toBe(true);
  });

  it('sem ativo fixo (capital parcial) → media + flag roic/eva disponíveis ainda', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: true,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
    });
    expect(r.nivel).toBe('media');
    expect(r.motivos.some((m) => m.toLowerCase().includes('parcial'))).toBe(true);
  });

  it('WACC null → wacc/eva indisponíveis e nível ≤ media', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: true, eva_null: true, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
    });
    expect(r.wacc_disponivel).toBe(false);
    expect(r.eva_disponivel).toBe(false);
    expect(r.nivel).not.toBe('alta');
  });

  it('sem normalização → normalizado indisponível + aviso', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: false, imposto_teorico_parcial: false, dre_confianca: 'alta',
    });
    expect(r.normalizado_disponivel).toBe(false);
    expect(r.motivos.some((m) => m.toLowerCase().includes('normaliz'))).toBe(true);
  });

  it('DRE baixa → baixa (pior sinal manda)', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'baixa',
    });
    expect(r.nivel).toBe('baixa');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-helpers`
Expected: FAIL — `scoreConfiancaValor is not a function`.

- [ ] **Step 3: Implementar (append)**

```ts
export type ConfiancaValor = {
  nivel: 'alta' | 'media' | 'baixa';
  motivos: string[];
  roic_disponivel: boolean;
  wacc_disponivel: boolean;
  eva_disponivel: boolean;
  normalizado_disponivel: boolean;
};

export function scoreConfiancaValor(input: {
  roic_null: boolean;
  wacc_null: boolean;
  eva_null: boolean;
  capital_parcial: boolean;
  normalizacao_aplicada: boolean;
  imposto_teorico_parcial: boolean;
  dre_confianca: 'alta' | 'media' | 'baixa';
}): ConfiancaValor {
  const motivos: string[] = [];
  let nivel = 3; // 3=alta, 2=media, 1=baixa — pega o pior sinal
  const rebaixar = (para: number, motivo: string) => { if (para < nivel) nivel = para; motivos.push(motivo); };

  if (input.capital_parcial) rebaixar(2, 'Capital investido parcial (sem ativo fixo) — ROIC/EVA parciais.');
  if (input.wacc_null) rebaixar(2, 'WACC/EVA/spread indisponíveis (faltam dívida, PL ou Ke).');
  if (!input.normalizacao_aplicada) rebaixar(2, 'Sem normalização de comingling — só visão reportada.');
  if (input.imposto_teorico_parcial) rebaixar(2, 'Config tributária incompleta — imposto operacional parcial (propaga da Onda 3).');
  if (input.dre_confianca === 'baixa') rebaixar(1, 'DRE subjacente com confiança baixa.');
  else if (input.dre_confianca === 'media') rebaixar(2, 'DRE subjacente com confiança média.');
  if (input.roic_null) rebaixar(2, 'ROIC indisponível (capital investido ≤ 0).');

  return {
    nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa',
    motivos,
    roic_disponivel: !input.roic_null,
    wacc_disponivel: !input.wacc_null,
    eva_disponivel: !input.eva_null,
    normalizado_disponivel: input.normalizacao_aplicada,
  };
}
```

- [ ] **Step 4: Rodar e ver passar (suite inteira do valor-helpers)**

Run: `bun run test -- valor-helpers`
Expected: PASS (todos os describes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-helpers.ts src/lib/financeiro/__tests__/valor-helpers.test.ts
git commit -m "feat(financeiro a2): scoreConfiancaValor (degrada por completude; nunca fabrica número)"
```

---

## Task 9: SQL — coluna `valor_inputs` (idempotente, entregue ao founder)

**Files:**
- Create: `supabase/migrations/20260523230000_fin_a2_valor_inputs.sql`

> Sem migration obrigatória pro app rodar (leitura defensiva `?? {}`). O arquivo fica no histórico; o founder cola o SQL no SQL Editor do Lovable. Entregar o bloco SQL inline na conversa (formato BLOCO único, ver §"Formatação de blocos SQL" do CLAUDE.md).

- [ ] **Step 1: Criar a migration**

```sql
-- supabase/migrations/20260523230000_fin_a2_valor_inputs.sql
-- A2 — Retorno & Valor: inputs manuais por empresa (ativo fixo, dívida, PL, Ke decomposto + cenários,
-- Kd, pró-labore real/mercado, aluguel de mercado, intercompany). Coluna OPCIONAL: o engine lê
-- defensivamente (?? {}) — sem ela, tudo degrada (só NOPAT + margem + capital de giro computados).

ALTER TABLE fin_config_cashflow
  ADD COLUMN IF NOT EXISTS valor_inputs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN fin_config_cashflow.valor_inputs IS
  'A2: { ativo_fixo:{valor,data_ref,fonte,base,operacional}, ajustes, divida, equity, kd, ke:{conservador,base,agressivo}, prolabore_real_mensal, prolabore_mercado_mensal, aluguel_mercado_mensal, intercompany_giro }';

-- Validação
SELECT 'A2 valor_inputs OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name='fin_config_cashflow' AND column_name='valor_inputs') AS coluna_existe;
```

- [ ] **Step 2: `bun run audit:migrations` (regenera o inventário)**

Run: `bun run audit:migrations`
Expected: roda sem erro; nova migration entra no inventário.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260523230000_fin_a2_valor_inputs.sql docs/migrations-audit.md scripts/audit-custom-migrations.sql 2>/dev/null
git commit -m "feat(financeiro a2): migration valor_inputs (coluna JSONB opcional em fin_config_cashflow)"
```

> O SQL inline pro SQL Editor será re-entregue na mensagem final ao founder (Task 14).

---

## Task 10: Edge function Deno `fin-valor-engine` (espelha helpers + lê DB)

**Files:**
- Create: `supabase/functions/fin-valor-engine/index.ts`

> Master-only (dado sensível: comp/patrimônio do dono). Boilerplate de auth copiado do `fin-cashflow-engine`, mas `allowed = new Set(['master'])`. Helpers copiados VERBATIM do `valor-helpers.ts` (sem `import` de `@/`; tipo `RegimeTributario` inlineado).

- [ ] **Step 1: Escrever a function completa**

```ts
// supabase/functions/fin-valor-engine/index.ts
// A2 — Retorno & Valor (ROIC/WACC/EVA). Master-only. Lê DRE TTM (fin_dre_snapshots),
// NCG (fin_projecao_snapshots.ncg) e inputs manuais (fin_config_cashflow.valor_inputs),
// e devolve o bloco "valor" por empresa. Helpers espelhados VERBATIM de src/lib/financeiro/valor-helpers.ts.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function unauthorized(message = "Unauthorized"): Response {
  return jsonResponse({ error: message }, 401);
}

// Master-only.
async function authorizeMaster(req: Request): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, response: unauthorized() };
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) return { ok: true };
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SERVICE_ROLE } });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };
    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!roleRes.ok) return { ok: false, response: unauthorized() };
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    if (roles.some((r) => r.role === "master")) return { ok: true };
    return { ok: false, response: unauthorized("Forbidden — master only") };
  } catch {
    return { ok: false, response: unauthorized() };
  }
}

// ===================== Helpers espelhados (verbatim de valor-helpers.ts) =====================
type RegimeTributario = "simples" | "presumido";
const REGIME_POR_EMPRESA: Record<string, RegimeTributario> = { colacor: "presumido", oben: "presumido", colacor_sc: "simples" };

type NopatInput = {
  regime: RegimeTributario; resultado_operacional_ttm: number; receitas_financeiras_ttm: number; despesas_financeiras_ttm: number;
  irpj_ttm: number; csll_ttm: number; das_ttm: number; pis_ttm: number; cofins_ttm: number; icms_ttm: number; iss_ttm: number; ipi_ttm: number;
};
function calcularNOPAT(input: NopatInput) {
  const ebit = input.resultado_operacional_ttm - input.receitas_financeiras_ttm + input.despesas_financeiras_ttm;
  const imposto_operacional_nopat = input.regime === "presumido" ? input.irpj_ttm + input.csll_ttm : 0;
  const nopat = ebit - imposto_operacional_nopat;
  const carga_tributaria_regime_total = input.regime === "simples"
    ? input.das_ttm
    : input.irpj_ttm + input.csll_ttm + input.pis_ttm + input.cofins_ttm + input.icms_ttm + input.iss_ttm + input.ipi_ttm;
  return { ebit, imposto_operacional_nopat, nopat, carga_tributaria_regime_total };
}
function margemOperacionalPreImposto(input: { ebit: number; receita_liquida: number }): number {
  if (input.receita_liquida <= 0) return 0;
  return input.ebit / input.receita_liquida;
}
type AtivoFixoInput = { valor: number; data_ref: string | null; fonte: "book" | "avaliacao" | "reposicao" | "seguro" | null; base: "reposicao" | "book" | null; operacional: boolean } | null;
function capitalInvestido(input: { capital_giro: number; ativo_fixo: AtivoFixoInput; ajustes?: number }) {
  const ajustes = input.ajustes ?? 0;
  const motivos: string[] = [];
  let ativo_fixo = 0; let parcial = false;
  if (input.ativo_fixo && input.ativo_fixo.operacional && Number.isFinite(input.ativo_fixo.valor)) ativo_fixo = input.ativo_fixo.valor;
  else { parcial = true; motivos.push("Ativo fixo operacional não informado — capital investido parcial (só giro − ajustes)."); }
  const capital_investido = input.capital_giro + ativo_fixo - ajustes;
  return { capital_investido, capital_giro: input.capital_giro, ativo_fixo, ajustes, parcial, motivos };
}
type KeDecomposto = { ancora: number; premio_risco_equity: number; premio_tamanho_private: number; premio_iliquidez_controle: number };
function somarKe(d: KeDecomposto): number { return d.ancora + d.premio_risco_equity + d.premio_tamanho_private + d.premio_iliquidez_controle; }
function waccHurdle(input: { ke: number | null; kd: number | null; divida: number | null; equity: number | null }) {
  const motivos: string[] = [];
  const base = { wacc: null as number | null, ke: input.ke, kd: input.kd, peso_divida: null as number | null, peso_equity: null as number | null, tax_shield_aplicado: false as const, motivos };
  if (input.ke == null) { motivos.push("Ke não informado — WACC indisponível."); return base; }
  if (input.equity == null) { motivos.push("PL (equity) não informado — WACC indisponível."); return base; }
  if (input.divida == null) { motivos.push("Dívida não informada — WACC indisponível."); return base; }
  const total = input.divida + input.equity;
  if (total <= 0) { motivos.push("Dívida + PL ≤ 0 — WACC indisponível."); return base; }
  if (input.divida > 0 && input.kd == null) { motivos.push("Há dívida mas Kd não informado — WACC indisponível."); return base; }
  const peso_divida = input.divida / total; const peso_equity = 1 - peso_divida; const kd = input.kd ?? 0;
  const wacc = peso_equity * input.ke + peso_divida * kd;
  return { wacc, ke: input.ke, kd: input.kd, peso_divida, peso_equity, tax_shield_aplicado: false as const, motivos };
}
function roic(input: { nopat: number; capital_investido: number | null }): number | null {
  if (input.capital_investido == null || input.capital_investido <= 0) return null;
  return input.nopat / input.capital_investido;
}
function spread(input: { roic: number | null; wacc: number | null }): number | null {
  if (input.roic == null || input.wacc == null) return null;
  return input.roic - input.wacc;
}
function eva(input: { spread: number | null; capital_investido: number | null }): number | null {
  if (input.spread == null || input.capital_investido == null) return null;
  return input.spread * input.capital_investido;
}
function roicIncremental(input: { nopat_atual: number; nopat_anterior: number | null; capital_atual: number | null; capital_anterior: number | null; limiar_delta_capital?: number }) {
  const limiar = input.limiar_delta_capital ?? 1000;
  if (input.nopat_anterior == null || input.capital_atual == null || input.capital_anterior == null) {
    return { roic_incremental: null, delta_nopat: null, delta_capital: null, aviso: "Histórico insuficiente (precisa de NOPAT e capital do TTM atual e do TTM −12m)." };
  }
  const delta_nopat = input.nopat_atual - input.nopat_anterior;
  const delta_capital = input.capital_atual - input.capital_anterior;
  if (delta_capital < limiar) return { roic_incremental: null, delta_nopat, delta_capital, aviso: "Variação de capital pequena ou negativa — ROIC incremental seria ruído." };
  return { roic_incremental: delta_nopat / delta_capital, delta_nopat, delta_capital, aviso: null };
}
function normalizarComingling(input: { ebit_reportado: number; capital_reportado: number; prolabore_real_ttm: number | null; prolabore_mercado_ttm: number | null; aluguel_mercado_ttm: number | null; intercompany_giro: number | null }) {
  const motivos: string[] = []; let aplicado = false;
  let ajuste_prolabore = 0;
  if (input.prolabore_real_ttm != null && input.prolabore_mercado_ttm != null) { ajuste_prolabore = input.prolabore_real_ttm - input.prolabore_mercado_ttm; aplicado = true; }
  else motivos.push("Pró-labore real/mercado não informado — sem normalização de pró-labore.");
  let ajuste_aluguel = 0;
  if (input.aluguel_mercado_ttm != null) { ajuste_aluguel = -input.aluguel_mercado_ttm; aplicado = true; }
  else motivos.push("Aluguel de mercado não informado — sem normalização de aluguel.");
  let ajuste_intercompany_capital = 0;
  if (input.intercompany_giro != null) { ajuste_intercompany_capital = -input.intercompany_giro; aplicado = true; }
  const ebit_normalizado = input.ebit_reportado + ajuste_prolabore + ajuste_aluguel;
  const capital_normalizado = input.capital_reportado + ajuste_intercompany_capital;
  if (!aplicado) motivos.push("Sem inputs de normalização — só visão reportada; possível comingling do dono não ajustado.");
  return { ebit_reportado: input.ebit_reportado, ebit_normalizado, capital_reportado: input.capital_reportado, capital_normalizado, ajuste_prolabore, ajuste_aluguel, ajuste_intercompany_capital, aplicado, motivos };
}
function scoreConfiancaValor(input: { roic_null: boolean; wacc_null: boolean; eva_null: boolean; capital_parcial: boolean; normalizacao_aplicada: boolean; imposto_teorico_parcial: boolean; dre_confianca: "alta" | "media" | "baixa" }) {
  const motivos: string[] = []; let nivel = 3;
  const rebaixar = (para: number, motivo: string) => { if (para < nivel) nivel = para; motivos.push(motivo); };
  if (input.capital_parcial) rebaixar(2, "Capital investido parcial (sem ativo fixo) — ROIC/EVA parciais.");
  if (input.wacc_null) rebaixar(2, "WACC/EVA/spread indisponíveis (faltam dívida, PL ou Ke).");
  if (!input.normalizacao_aplicada) rebaixar(2, "Sem normalização de comingling — só visão reportada.");
  if (input.imposto_teorico_parcial) rebaixar(2, "Config tributária incompleta — imposto operacional parcial (propaga da Onda 3).");
  if (input.dre_confianca === "baixa") rebaixar(1, "DRE subjacente com confiança baixa.");
  else if (input.dre_confianca === "media") rebaixar(2, "DRE subjacente com confiança média.");
  if (input.roic_null) rebaixar(2, "ROIC indisponível (capital investido ≤ 0).");
  return {
    nivel: (nivel === 3 ? "alta" : nivel === 2 ? "media" : "baixa") as "alta" | "media" | "baixa",
    motivos, roic_disponivel: !input.roic_null, wacc_disponivel: !input.wacc_null, eva_disponivel: !input.eva_null, normalizado_disponivel: input.normalizacao_aplicada,
  };
}

// ===================== Leitura de DB + orquestração =====================
type Company = "oben" | "colacor" | "colacor_sc";
type Input = { company: Company };

// Snapshot mensal da DRE (subset usado)
type DreRow = {
  ano: number; mes: number;
  receita_liquida: number; resultado_operacional: number; receitas_financeiras: number; despesas_financeiras: number;
  detalhamento: { impostos?: Record<string, number>; confianca?: { nivel?: "alta" | "media" | "baixa" } } | null;
};

function somaJanela(rows: DreRow[], idxFim: number, meses = 12) {
  // janela [idxFim − (meses−1), idxFim] inclusiva, por ano*12+mes
  const acc = {
    receita_liquida: 0, resultado_operacional: 0, receitas_financeiras: 0, despesas_financeiras: 0,
    irpj: 0, csll: 0, das: 0, ded_pis: 0, ded_cofins: 0, ded_icms: 0, ded_iss: 0, ded_ipi: 0,
    confianca_pior: 3, count: 0,
  };
  const nivelNum = (n?: string) => (n === "baixa" ? 1 : n === "media" ? 2 : 3);
  for (const r of rows) {
    const idx = r.ano * 12 + r.mes;
    if (idx < idxFim - (meses - 1) || idx > idxFim) continue;
    acc.count++;
    acc.receita_liquida += r.receita_liquida ?? 0;
    acc.resultado_operacional += r.resultado_operacional ?? 0;
    acc.receitas_financeiras += r.receitas_financeiras ?? 0;
    acc.despesas_financeiras += r.despesas_financeiras ?? 0;
    const imp = r.detalhamento?.impostos ?? {};
    acc.irpj += imp.irpj ?? 0; acc.csll += imp.csll ?? 0; acc.das += imp.das ?? 0;
    acc.ded_pis += imp.ded_pis ?? 0; acc.ded_cofins += imp.ded_cofins ?? 0; acc.ded_icms += imp.ded_icms ?? 0;
    acc.ded_iss += imp.ded_iss ?? 0; acc.ded_ipi += imp.ded_ipi ?? 0;
    const n = nivelNum(r.detalhamento?.confianca?.nivel);
    if (n < acc.confianca_pior) acc.confianca_pior = n;
  }
  return acc;
}

// Shape cru (defensivo) do JSONB valor_inputs — campos numéricos como unknown (validados via numOrNull).
type ValorInputsRaw = {
  ativo_fixo?: {
    valor?: unknown;
    data_ref?: string | null;
    fonte?: "book" | "avaliacao" | "reposicao" | "seguro" | null;
    base?: "reposicao" | "book" | null;
    operacional?: boolean;
  } | null;
  ajustes?: unknown;
  divida?: unknown;
  equity?: unknown;
  kd?: unknown;
  ke?: Record<string, KeDecomposto | undefined>;
  prolabore_real_mensal?: unknown;
  prolabore_mercado_mensal?: unknown;
  aluguel_mercado_mensal?: unknown;
  intercompany_giro?: unknown;
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeMaster(req);
  if (!auth.ok) return auth.response;

  let payload: Input;
  try { payload = await req.json(); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
  const company = payload.company;
  if (!company) return jsonResponse({ error: "company obrigatório" }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE);

  // 1) Config: regime + valor_inputs (defensivo)
  const { data: cfgRaw } = await db.from("fin_config_cashflow")
    .select("dre_tributario, valor_inputs").eq("company", company).maybeSingle();
  const cfg = (cfgRaw ?? {}) as { dre_tributario?: { regime?: RegimeTributario; anexo?: string } | null; valor_inputs?: Record<string, unknown> | null };
  const regime: RegimeTributario = (cfg.dre_tributario?.regime as RegimeTributario) ?? REGIME_POR_EMPRESA[company] ?? "presumido";
  const vi = (cfg.valor_inputs ?? {}) as ValorInputsRaw;
  // Config tributária completa? (propaga rebaixamento de confiança da Onda 3b)
  const configCompleta = regime === "presumido" ? cfg.dre_tributario != null : (cfg.dre_tributario?.anexo != null);
  const imposto_teorico_parcial = !configCompleta;

  // 2) DRE TTM (regime competência)
  const { data: dreRows } = await db.from("fin_dre_snapshots")
    .select("ano, mes, receita_liquida, resultado_operacional, receitas_financeiras, despesas_financeiras, detalhamento")
    .eq("company", company).eq("regime", "competencia");
  const rows = (dreRows ?? []) as DreRow[];
  if (rows.length === 0) {
    return jsonResponse({ error: "Sem snapshots de DRE (competência) para esta empresa. Rode a DRE primeiro." }, 422);
  }
  const idxFim = Math.max(...rows.map((r) => r.ano * 12 + r.mes));
  const ttm = somaJanela(rows, idxFim, 12);
  const ttmAnterior = somaJanela(rows, idxFim - 12, 12);
  const ano_mes_fim = `${Math.floor((idxFim - 1) / 12)}-${String(((idxFim - 1) % 12) + 1).padStart(2, "0")}`;
  const dre_confianca: "alta" | "media" | "baixa" = ttm.confianca_pior === 1 ? "baixa" : ttm.confianca_pior === 2 ? "media" : "alta";

  // 3) Capital de giro: último ncg snapshot + ncg ~365d antes
  const { data: snaps } = await db.from("fin_projecao_snapshots")
    .select("ncg, snapshot_at").eq("company", company).order("snapshot_at", { ascending: false }).limit(400);
  const snapRows = (snaps ?? []) as Array<{ ncg: number | null; snapshot_at: string }>;
  const capital_giro = snapRows.length > 0 && snapRows[0].ncg != null ? Number(snapRows[0].ncg) : 0;
  let capital_giro_anterior: number | null = null;
  if (snapRows.length > 0) {
    const alvo = new Date(snapRows[0].snapshot_at).getTime() - 365 * 86400000;
    let melhor: { ncg: number | null; dist: number } | null = null;
    for (const s of snapRows) {
      if (s.ncg == null) continue;
      const dist = Math.abs(new Date(s.snapshot_at).getTime() - alvo);
      if (melhor == null || dist < melhor.dist) melhor = { ncg: s.ncg, dist };
    }
    // só aceita se o snapshot encontrado está a ≤ 60 dias do alvo (senão não há histórico real de 12m)
    if (melhor && melhor.dist <= 60 * 86400000) capital_giro_anterior = Number(melhor.ncg);
  }

  // 4) Inputs manuais (mensais → TTM via ×12)
  const numOrNull = (x: unknown): number | null => (x == null || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
  const ativo_fixo: AtivoFixoInput = vi.ativo_fixo && numOrNull(vi.ativo_fixo.valor) != null
    ? { valor: Number(vi.ativo_fixo.valor), data_ref: vi.ativo_fixo.data_ref ?? null, fonte: vi.ativo_fixo.fonte ?? null, base: vi.ativo_fixo.base ?? null, operacional: vi.ativo_fixo.operacional !== false }
    : null;
  const ajustes = Number(vi.ajustes ?? 0);
  const divida = numOrNull(vi.divida);
  const equity = numOrNull(vi.equity);
  const kd = numOrNull(vi.kd);
  const keCen = (vi.ke ?? {}) as Record<string, KeDecomposto | undefined>;
  const keBase = keCen.base ?? null;
  const prolabore_real_ttm = numOrNull(vi.prolabore_real_mensal) != null ? Number(vi.prolabore_real_mensal) * 12 : null;
  const prolabore_mercado_ttm = numOrNull(vi.prolabore_mercado_mensal) != null ? Number(vi.prolabore_mercado_mensal) * 12 : null;
  const aluguel_mercado_ttm = numOrNull(vi.aluguel_mercado_mensal) != null ? Number(vi.aluguel_mercado_mensal) * 12 : null;
  const intercompany_giro = numOrNull(vi.intercompany_giro);

  // 5) NOPAT (atual + anterior)
  const nopatIn = (j: typeof ttm): NopatInput => ({
    regime,
    resultado_operacional_ttm: j.resultado_operacional, receitas_financeiras_ttm: j.receitas_financeiras, despesas_financeiras_ttm: j.despesas_financeiras,
    irpj_ttm: j.irpj, csll_ttm: j.csll, das_ttm: j.das, pis_ttm: j.ded_pis, cofins_ttm: j.ded_cofins, icms_ttm: j.ded_icms, iss_ttm: j.ded_iss, ipi_ttm: j.ded_ipi,
  });
  const nopatAtual = calcularNOPAT(nopatIn(ttm));
  const nopatAnterior = ttmAnterior.count >= 12 ? calcularNOPAT(nopatIn(ttmAnterior)) : null;

  // 6) Capital investido (reportado) — AF cancela no incremental (mesmo AF nos dois pontos)
  const capRep = capitalInvestido({ capital_giro, ativo_fixo, ajustes });
  const capAnterior = capital_giro_anterior != null ? capitalInvestido({ capital_giro: capital_giro_anterior, ativo_fixo, ajustes }).capital_investido : null;

  // 7) WACC (base + cenários)
  const waccDe = (ke: KeDecomposto | null | undefined) => waccHurdle({ ke: ke ? somarKe(ke) : null, kd, divida, equity });
  const waccBase = waccDe(keBase);
  const wacc_cenarios = {
    conservador: waccDe(keCen.conservador).wacc,
    base: waccBase.wacc,
    agressivo: waccDe(keCen.agressivo).wacc,
  };

  // 8) ROIC/spread/EVA (reportado)
  const roicRep = roic({ nopat: nopatAtual.nopat, capital_investido: capRep.capital_investido });
  const spreadRep = spread({ roic: roicRep, wacc: waccBase.wacc });
  const evaRep = eva({ spread: spreadRep, capital_investido: capRep.capital_investido });
  const incremental = roicIncremental({ nopat_atual: nopatAtual.nopat, nopat_anterior: nopatAnterior?.nopat ?? null, capital_atual: capRep.capital_investido, capital_anterior: capAnterior });

  // 9) Normalização (comingling) → NOPAT/ROIC/EVA normalizados
  const cg = normalizarComingling({
    ebit_reportado: nopatAtual.ebit, capital_reportado: capRep.capital_investido,
    prolabore_real_ttm, prolabore_mercado_ttm, aluguel_mercado_ttm, intercompany_giro,
  });
  const impostoNorm = regime === "presumido" ? nopatAtual.imposto_operacional_nopat : 0;
  const nopatNorm = cg.ebit_normalizado - impostoNorm;
  const roicNorm = roic({ nopat: nopatNorm, capital_investido: cg.capital_normalizado });
  const spreadNorm = spread({ roic: roicNorm, wacc: waccBase.wacc });
  const evaNorm = eva({ spread: spreadNorm, capital_investido: cg.capital_normalizado });

  // 10) Confiança
  const confianca = scoreConfiancaValor({
    roic_null: roicRep == null, wacc_null: waccBase.wacc == null, eva_null: evaRep == null,
    capital_parcial: capRep.parcial, normalizacao_aplicada: cg.aplicado, imposto_teorico_parcial, dre_confianca,
  });

  const result = {
    company, regime,
    ttm: { ano_mes_fim, meses: ttm.count, tem_anterior: nopatAnterior != null && capAnterior != null },
    reportado: {
      ebit: nopatAtual.ebit, nopat: nopatAtual.nopat,
      imposto_operacional_nopat: nopatAtual.imposto_operacional_nopat,
      carga_tributaria_regime_total: nopatAtual.carga_tributaria_regime_total,
      margem_operacional_pre_imposto: margemOperacionalPreImposto({ ebit: nopatAtual.ebit, receita_liquida: ttm.receita_liquida }),
      receita_liquida_ttm: ttm.receita_liquida,
      capital_investido: capRep.capital_investido, capital_giro: capRep.capital_giro, ativo_fixo: capRep.ativo_fixo, ajustes: capRep.ajustes, capital_parcial: capRep.parcial,
      roic: roicRep, wacc: waccBase.wacc, spread: spreadRep, eva: evaRep,
      roic_incremental: incremental.roic_incremental,
      incremental: { delta_nopat: incremental.delta_nopat, delta_capital: incremental.delta_capital, aviso: incremental.aviso },
      wacc_cenarios, peso_divida: waccBase.peso_divida, peso_equity: waccBase.peso_equity,
    },
    normalizado: {
      ebit: cg.ebit_normalizado, nopat: nopatNorm, capital_investido: cg.capital_normalizado,
      roic: roicNorm, spread: spreadNorm, eva: evaNorm,
      ajuste_prolabore: cg.ajuste_prolabore, ajuste_aluguel: cg.ajuste_aluguel, ajuste_intercompany_capital: cg.ajuste_intercompany_capital,
      aplicado: cg.aplicado,
    },
    confianca,
    motivos: [...capRep.motivos, ...waccBase.motivos, ...cg.motivos],
  };
  return jsonResponse(result, 200);
});
```

- [ ] **Step 2: `deno check` no engine novo**

Run: `deno check supabase/functions/fin-valor-engine/index.ts`
Expected: sem erros NOVOS no arquivo. (Ignorar TS2571/TS2345/TS2578 pré-existentes em outras funções, conforme CLAUDE.md.) Se `deno` não estiver no PATH, anotar e validar manualmente a tipagem; o teste real é o deploy no Lovable.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/fin-valor-engine/index.ts
git commit -m "feat(financeiro a2): edge function fin-valor-engine (master-only; espelha valor-helpers)"
```

> Re-deploy via chat Lovable — prompt entregue na Task 14.

---

## Task 11: Tipos no serviço + hook `useValor` + mutation `useUpdateValorInputs`

**Files:**
- Modify: `src/services/financeiroService.ts` (append dos tipos do contrato)
- Create: `src/hooks/useValor.ts`

- [ ] **Step 1: Adicionar os tipos do contrato no fim de `src/services/financeiroService.ts`**

```ts
// ═══════════════ A2 — Retorno & Valor (contrato com fin-valor-engine) ═══════════════

export interface ValorKeDecomposto {
  ancora: number;
  premio_risco_equity: number;
  premio_tamanho_private: number;
  premio_iliquidez_controle: number;
}

export interface ValorInputs {
  ativo_fixo?: { valor: number; data_ref: string | null; fonte: 'book' | 'avaliacao' | 'reposicao' | 'seguro' | null; base: 'reposicao' | 'book' | null; operacional: boolean } | null;
  ajustes?: number;
  divida?: number | null;
  equity?: number | null;
  kd?: number | null;
  ke?: { conservador?: ValorKeDecomposto; base?: ValorKeDecomposto; agressivo?: ValorKeDecomposto };
  prolabore_real_mensal?: number | null;
  prolabore_mercado_mensal?: number | null;
  aluguel_mercado_mensal?: number | null;
  intercompany_giro?: number | null;
}

export interface ValorEmpresaResult {
  company: string;
  regime: 'simples' | 'presumido';
  ttm: { ano_mes_fim: string; meses: number; tem_anterior: boolean };
  reportado: {
    ebit: number; nopat: number; imposto_operacional_nopat: number; carga_tributaria_regime_total: number;
    margem_operacional_pre_imposto: number; receita_liquida_ttm: number;
    capital_investido: number; capital_giro: number; ativo_fixo: number; ajustes: number; capital_parcial: boolean;
    roic: number | null; wacc: number | null; spread: number | null; eva: number | null;
    roic_incremental: number | null;
    incremental: { delta_nopat: number | null; delta_capital: number | null; aviso: string | null };
    wacc_cenarios: { conservador: number | null; base: number | null; agressivo: number | null };
    peso_divida: number | null; peso_equity: number | null;
  };
  normalizado: {
    ebit: number; nopat: number; capital_investido: number;
    roic: number | null; spread: number | null; eva: number | null;
    ajuste_prolabore: number; ajuste_aluguel: number; ajuste_intercompany_capital: number; aplicado: boolean;
  };
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[]; roic_disponivel: boolean; wacc_disponivel: boolean; eva_disponivel: boolean; normalizado_disponivel: boolean };
  motivos: string[];
}
```

- [ ] **Step 2: Criar `src/hooks/useValor.ts`**

```ts
// src/hooks/useValor.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ValorEmpresaResult, ValorInputs } from '@/services/financeiroService';

export function useValor(company: string) {
  return useQuery({
    queryKey: ['fin_valor', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<ValorEmpresaResult> => {
      const { data, error } = await supabase.functions.invoke('fin-valor-engine', { body: { company } });
      if (error) throw error;
      return data as ValorEmpresaResult;
    },
  });
}

export function useUpdateValorInputs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ company, valor_inputs }: { company: string; valor_inputs: ValorInputs }) => {
      const { error } = await supabase
        .from('fin_config_cashflow')
        .update({ valor_inputs: valor_inputs as unknown as Record<string, unknown> })
        .eq('company', company);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['fin_valor', vars.company] });
    },
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: sem erros novos. (Se `valor_inputs` não existir nos tipos gerados do Supabase, o `as unknown as Record<string, unknown>` no update já protege; a leitura no engine é defensiva. Não regenerar types do Supabase aqui.)

- [ ] **Step 4: Commit**

```bash
git add src/services/financeiroService.ts src/hooks/useValor.ts
git commit -m "feat(financeiro a2): tipos do contrato + hook useValor + useUpdateValorInputs"
```

---

## Task 12: Dialog do formulário + página `/financeiro/valor` + rota + sidebar

**Files:**
- Create: `src/components/financeiro/ValorInputsDialog.tsx`
- Create: `src/pages/FinanceiroValor.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Criar `src/components/financeiro/ValorInputsDialog.tsx`**

```tsx
// src/components/financeiro/ValorInputsDialog.tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useUpdateValorInputs } from '@/hooks/useValor';
import type { ValorInputs } from '@/services/financeiroService';

const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function ValorInputsDialog({ company, atual }: { company: string; atual?: ValorInputs }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateValorInputs();
  const a = atual ?? {};
  // Campos planos (percentuais em fração, ex.: 0.20 = 20%).
  const [f, setF] = useState({
    ativo_fixo_valor: a.ativo_fixo?.valor != null ? String(a.ativo_fixo.valor) : '',
    ativo_fixo_data: a.ativo_fixo?.data_ref ?? '',
    ativo_fixo_base: a.ativo_fixo?.base ?? 'reposicao',
    ajustes: a.ajustes != null ? String(a.ajustes) : '',
    divida: a.divida != null ? String(a.divida) : '',
    equity: a.equity != null ? String(a.equity) : '',
    kd: a.kd != null ? String(a.kd) : '',
    ke_base_ancora: a.ke?.base?.ancora != null ? String(a.ke.base.ancora) : '',
    ke_base_re: a.ke?.base?.premio_risco_equity != null ? String(a.ke.base.premio_risco_equity) : '',
    ke_base_tam: a.ke?.base?.premio_tamanho_private != null ? String(a.ke.base.premio_tamanho_private) : '',
    ke_base_iliq: a.ke?.base?.premio_iliquidez_controle != null ? String(a.ke.base.premio_iliquidez_controle) : '',
    prolabore_real: a.prolabore_real_mensal != null ? String(a.prolabore_real_mensal) : '',
    prolabore_mercado: a.prolabore_mercado_mensal != null ? String(a.prolabore_mercado_mensal) : '',
    aluguel_mercado: a.aluguel_mercado_mensal != null ? String(a.aluguel_mercado_mensal) : '',
    intercompany_giro: a.intercompany_giro != null ? String(a.intercompany_giro) : '',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const salvar = async () => {
    const afValor = num(f.ativo_fixo_valor);
    const keBase = (num(f.ke_base_ancora) != null || num(f.ke_base_re) != null)
      ? { ancora: num(f.ke_base_ancora) ?? 0, premio_risco_equity: num(f.ke_base_re) ?? 0, premio_tamanho_private: num(f.ke_base_tam) ?? 0, premio_iliquidez_controle: num(f.ke_base_iliq) ?? 0 }
      : undefined;
    const valor_inputs: ValorInputs = {
      ativo_fixo: afValor != null ? { valor: afValor, data_ref: f.ativo_fixo_data || null, fonte: 'reposicao', base: (f.ativo_fixo_base as 'reposicao' | 'book') || 'reposicao', operacional: true } : null,
      ajustes: num(f.ajustes) ?? 0,
      divida: num(f.divida),
      equity: num(f.equity),
      kd: num(f.kd),
      ke: keBase ? { base: keBase, conservador: keBase, agressivo: keBase } : undefined,
      prolabore_real_mensal: num(f.prolabore_real),
      prolabore_mercado_mensal: num(f.prolabore_mercado),
      aluguel_mercado_mensal: num(f.aluguel_mercado),
      intercompany_giro: num(f.intercompany_giro),
    };
    try {
      await update.mutateAsync({ company, valor_inputs });
      toast.success('Inputs salvos. Recalculando…');
      setOpen(false);
    } catch (e) {
      toast.error('Falha ao salvar inputs', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Inputs ({company})</Button></DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Inputs manuais — {company}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2 text-xs text-muted-foreground">Taxas em fração (0.20 = 20%). Valores em R$. Pró-labore/aluguel são MENSAIS.</div>
          <div><Label>Ativo fixo (R$)</Label><Input value={f.ativo_fixo_valor} onChange={set('ativo_fixo_valor')} inputMode="decimal" /></div>
          <div><Label>AF — data ref</Label><Input value={f.ativo_fixo_data} onChange={set('ativo_fixo_data')} placeholder="2026-01-01" /></div>
          <div><Label>Ajustes/exclusões (R$)</Label><Input value={f.ajustes} onChange={set('ajustes')} inputMode="decimal" /></div>
          <div><Label>Dívida (R$)</Label><Input value={f.divida} onChange={set('divida')} inputMode="decimal" /></div>
          <div><Label>PL / equity (R$)</Label><Input value={f.equity} onChange={set('equity')} inputMode="decimal" /></div>
          <div><Label>Kd (fração)</Label><Input value={f.kd} onChange={set('kd')} inputMode="decimal" /></div>
          <div className="col-span-2 mt-2 font-medium">Ke (base) decomposto</div>
          <div><Label>Âncora (CDI/NTN-B)</Label><Input value={f.ke_base_ancora} onChange={set('ke_base_ancora')} inputMode="decimal" /></div>
          <div><Label>Prêmio risco equity</Label><Input value={f.ke_base_re} onChange={set('ke_base_re')} inputMode="decimal" /></div>
          <div><Label>Prêmio tamanho</Label><Input value={f.ke_base_tam} onChange={set('ke_base_tam')} inputMode="decimal" /></div>
          <div><Label>Prêmio iliquidez/controle</Label><Input value={f.ke_base_iliq} onChange={set('ke_base_iliq')} inputMode="decimal" /></div>
          <div className="col-span-2 mt-2 font-medium">Normalização (comingling)</div>
          <div><Label>Pró-labore real (R$/mês)</Label><Input value={f.prolabore_real} onChange={set('prolabore_real')} inputMode="decimal" /></div>
          <div><Label>Pró-labore mercado (R$/mês)</Label><Input value={f.prolabore_mercado} onChange={set('prolabore_mercado')} inputMode="decimal" /></div>
          <div><Label>Aluguel mercado (R$/mês)</Label><Input value={f.aluguel_mercado} onChange={set('aluguel_mercado')} inputMode="decimal" /></div>
          <div><Label>Intercompany no giro (R$)</Label><Input value={f.intercompany_giro} onChange={set('intercompany_giro')} inputMode="decimal" /></div>
        </div>
        <DialogFooter>
          <Button onClick={salvar} disabled={update.isPending}>{update.isPending ? 'Salvando…' : 'Salvar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Criar `src/pages/FinanceiroValor.tsx`**

```tsx
// src/pages/FinanceiroValor.tsx
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useValor } from '@/hooks/useValor';
import { ValorInputsDialog } from '@/components/financeiro/ValorInputsDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import type { ValorEmpresaResult } from '@/services/financeiroService';

const EMPRESAS = ['colacor', 'oben', 'colacor_sc'] as const;
const NOME: Record<string, string> = { colacor: 'Colacor', oben: 'Oben', colacor_sc: 'Colacor SC' };

const pct = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const brl = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));

function nivelClasses(n: 'alta' | 'media' | 'baixa') {
  if (n === 'alta') return 'text-status-success bg-status-success-bg';
  if (n === 'media') return 'text-status-warning bg-status-warning-bg';
  return 'text-status-error bg-status-error-bg';
}

function EmpresaCard({ company, modo }: { company: string; modo: 'reportado' | 'normalizado' }) {
  const { data, isLoading, error } = useValor(company);
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <Card><CardContent className="py-6 text-sm text-status-error">Erro ao carregar {NOME[company]}: {error instanceof Error ? error.message : String(error)}</CardContent></Card>;
  if (!data) return null;
  const v = modo === 'normalizado' ? data.normalizado : data.reportado;
  const roic = v.roic; const spreadV = v.spread; const evaV = v.eva;
  const wacc = data.reportado.wacc; // WACC é o mesmo nos dois modos
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{NOME[company]} <span className="text-xs text-muted-foreground">({data.regime})</span></CardTitle>
        <span className={`text-xs px-2 py-0.5 rounded ${nivelClasses(data.confianca.nivel)}`}>confiança {data.confianca.nivel}</span>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-muted-foreground">ROIC</span><span className="kpi-value text-right">{pct(roic)}</span>
          <span className="text-muted-foreground">WACC (hurdle)</span><span className="text-right">{pct(wacc)}</span>
          <span className="text-muted-foreground">Spread</span><span className={`text-right ${spreadV != null && spreadV < 0 ? 'text-status-error' : 'text-status-success'}`}>{pct(spreadV)}</span>
          <span className="text-muted-foreground">EVA</span><span className="text-right">{brl(evaV)}</span>
          <span className="text-muted-foreground">NOPAT (TTM)</span><span className="text-right">{brl(v.nopat)}</span>
          <span className="text-muted-foreground">Capital investido</span><span className="text-right">{brl(v.capital_investido)}{data.reportado.capital_parcial && modo === 'reportado' ? ' *' : ''}</span>
          {modo === 'reportado' && (<><span className="text-muted-foreground">Margem op. pré-imposto</span><span className="text-right">{pct(data.reportado.margem_operacional_pre_imposto)}</span></>)}
          <span className="text-muted-foreground">ROIC incremental</span><span className="kpi-value text-right">{pct(data.reportado.roic_incremental)}</span>
        </div>
        {data.reportado.capital_parcial && modo === 'reportado' && <p className="text-xs text-status-warning">* capital parcial (sem ativo fixo)</p>}
        {data.reportado.incremental.aviso && <p className="text-xs text-muted-foreground">{data.reportado.incremental.aviso}</p>}
        {modo === 'normalizado' && !data.normalizado.aplicado && <p className="text-xs text-status-warning">Sem inputs de normalização — igual ao reportado.</p>}
        {data.confianca.motivos.length > 0 && (
          <details className="text-xs text-muted-foreground"><summary>Por que essa confiança?</summary><ul className="list-disc pl-4 mt-1">{data.confianca.motivos.map((m, i) => <li key={i}>{m}</li>)}</ul></details>
        )}
        <ValorInputsDialog company={company} />
      </CardContent>
    </Card>
  );
}

function Ranking({ modo }: { modo: 'reportado' | 'normalizado' }) {
  const r = EMPRESAS.map((c) => ({ c, q: useValor(c) }));
  const rows: Array<{ company: string; incr: number | null; spread: number | null }> = r.map(({ c, q }) => ({
    company: c,
    incr: (q.data as ValorEmpresaResult | undefined)?.reportado.roic_incremental ?? null,
    spread: (q.data as ValorEmpresaResult | undefined)?.[modo].spread ?? null,
  }));
  const byIncr = [...rows].sort((a, b) => (b.incr ?? -Infinity) - (a.incr ?? -Infinity));
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Ranking — onde o próximo R$1 rende mais</CardTitle></CardHeader>
      <CardContent className="text-sm space-y-1">
        {byIncr.map((row, i) => (
          <div key={row.company} className="flex justify-between border-b border-border py-1 last:border-0">
            <span>{i + 1}. {NOME[row.company]}</span>
            <span className="font-mono">ROIC incr. {pct(row.incr)} · spread {pct(row.spread)}</span>
          </div>
        ))}
        <p className="text-xs text-muted-foreground pt-2">ROIC incremental = ΔNOPAT / Δcapital (TTM atual vs −12m). "—" = histórico insuficiente ou Δcapital pequeno/negativo.</p>
      </CardContent>
    </Card>
  );
}

export default function FinanceiroValor() {
  const { isMaster } = useAuth();
  const [modo, setModo] = useState<'reportado' | 'normalizado'>('reportado');
  if (!isMaster) {
    return <div className="p-6"><Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Acesso restrito — Retorno &amp; Valor é visível apenas para master.</CardContent></Card></div>;
  }
  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl">Retorno &amp; Valor</h1>
          <p className="text-sm text-muted-foreground">ROIC, WACC (hurdle-rate), EVA e spread por empresa — alocação de capital entre Colacor, Oben e Colacor SC.</p>
        </div>
        <div className="flex gap-2">
          <Button variant={modo === 'reportado' ? 'default' : 'outline'} size="sm" onClick={() => setModo('reportado')}>Reportado</Button>
          <Button variant={modo === 'normalizado' ? 'default' : 'outline'} size="sm" onClick={() => setModo('normalizado')}>Normalizado</Button>
        </div>
      </div>
      <Ranking modo={modo} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {EMPRESAS.map((c) => <EmpresaCard key={c} company={c} modo={modo} />)}
      </div>
      <p className="text-xs text-muted-foreground">
        Direcional: melhora a decisão de alocação de capital, mas leases/quase-dívida, capex de manutenção × crescimento, eliminação intercompany e registro automático de ativo fixo estão deferidos (ver spec A2).
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Registrar a rota em `src/App.tsx`**

Adicionar o lazy import junto aos outros (perto da linha 110, após `FinanceiroTributario`):

```tsx
const FinanceiroValor = lazy(() => import("./pages/FinanceiroValor"));
```

Adicionar a rota junto às outras `financeiro/*` (após a linha 284, `financeiro/tributario`):

```tsx
              <Route path="financeiro/valor" element={<FinanceiroValor />} />
```

- [ ] **Step 4: Adicionar link na sidebar (`src/components/AppShell.tsx`), seção Financeiro, master-only**

Localizar os itens da seção Financeiro (onde estão os links `financeiro/*`). Adicionar, gateado por master:

```tsx
{isMaster && { label: 'Retorno & Valor', to: '/financeiro/valor' }}
```

> Ajustar à estrutura real da lista de itens da seção (o array pode ser de objetos `{ label, to, icon }`). Se a seção montar itens via `.filter(Boolean)`, o padrão `isMaster && {...}` funciona. Caso contrário, condicionar a inclusão do item. Confirmar que `isMaster` vem de `useAuth()` (já usado no AppShell).

- [ ] **Step 5: Rodar dev server e validar visualmente**

Run: `bun dev` e abrir `http://localhost:8080/financeiro/valor` logado como master.
Expected: página renderiza 3 cards + ranking + toggle; sem crash no console. Com `valor_inputs` vazio: ROIC/NOPAT/margem aparecem (computados), WACC/EVA "—" (sem inputs), banner confiança "media/baixa" com motivos. Abrir o dialog de Inputs, salvar valores, ver recalcular.

> Se não der pra logar como master no ambiente local, anotar explicitamente "UI não testada ao vivo" e validar ao menos que `bun build` passa (Step 6).

- [ ] **Step 6: Typecheck + build**

Run: `bunx tsc --noEmit && bun build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pages/FinanceiroValor.tsx src/components/financeiro/ValorInputsDialog.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(financeiro a2): página /financeiro/valor (master-only) + dialog de inputs + rota + sidebar"
```

---

## Task 13: Docs — seção A2 em `FINANCEIRO_CONFIABILIDADE.md`

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md` (inserir após a seção "Onda 3b", antes de "MVP Operacional")

- [ ] **Step 1: Inserir a seção A2**

```markdown
## 🔧 A2 — Retorno & Valor (ROIC / WACC / EVA)

Camada de retorno sobre o capital empregado, pra decidir **onde colocar o próximo R$1** entre as 3 empresas. Híbrida: NOPAT e capital de giro são **computados** (reusam DRE v2 + NCG); ativo fixo, dívida, PL, Ke/Kd e normalizações são **inputs manuais** (`fin_config_cashflow.valor_inputs`), com degradação honesta.

| Item | Como é calculado |
| --- | --- |
| **NOPAT** | EBIT operacional puro (`resultado_operacional − receitas_financeiras + despesas_financeiras`, TTM) **menos** só os impostos **abaixo da linha**: presumido `IRPJ+CSLL`; Simples `0` (DAS já está nas deduções). Nunca `EBIT×(1−t)`. Sem clamp (NOPAT pode ser negativo). Carga tributária total do regime é exibida à parte, **nunca** re-subtraída. |
| **Margem op. pré-imposto** | `EBIT / receita_líquida` — comparável entre regimes. |
| **Capital investido** | `capital_giro (NCG do último snapshot) + ativo_fixo (manual) − ajustes`. Sem ativo fixo → **parcial** + confiança rebaixada. |
| **WACC (hurdle-rate)** | `peso_equity·Ke + peso_dívida·Kd`. Ke decomposto (âncora + prêmios) com cenários conservador/base/agressivo; **Kd pré-imposto** (tax-shield desligado nos 2 regimes). Sem dívida/PL/Ke → **indisponível** (não chuta). |
| **ROIC / spread / EVA** | `ROIC = NOPAT/capital`; `spread = ROIC − WACC`; `EVA = spread × capital`. Capital ≤ 0 → null. |
| **ROIC incremental (headline)** | `ΔNOPAT / Δcapital` (TTM atual vs −12m). Δcapital pequeno/negativo ou histórico insuficiente → `null` + aviso. |
| **Normalização (comingling)** | Pró-labore de mercado, aluguel de mercado e intercompany. Saída **reportado vs normalizado** lado a lado; o normalizado é o número de decisão. |
| **Confiança** | `alta/media/baixa` por completude dos inputs; nunca fabrica número (campo ausente = `null` + motivo). Propaga a confiança da DRE subjacente (Onda 3). |

**Regra de ouro:** A2 nunca inventa. Faltou ativo fixo → ROIC parcial. Faltou dívida/PL/Ke → WACC/EVA/spread indisponíveis. Faltou normalização → só reportado, com aviso de comingling.

**Limitações / próximos ciclos (deferidos, documentados):** leases/aluguéis como quase-dívida; split capex manutenção × crescimento; eliminação intercompany pra view consolidada; registro automático de ativo fixo (sync ERP); real vs nominal/inflação; concentração cliente/fornecedor; obsolescência de estoque. Migração de regime pra lucro real reativaria o tax-shield. **A2 é direcional**, não auditoria.

**Onde:** helper `src/lib/financeiro/valor-helpers.ts` (vitest); engine `supabase/functions/fin-valor-engine` (master-only, espelha o helper); coluna `fin_config_cashflow.valor_inputs` (JSONB opcional); UI `/financeiro/valor` (master-only).
```

- [ ] **Step 2: Commit**

```bash
git add docs/FINANCEIRO_CONFIABILIDADE.md
git commit -m "docs(financeiro a2): seção Retorno & Valor em CONFIABILIDADE"
```

---

## Task 14: Validação final + entregáveis ao founder (SQL + prompt de deploy)

**Files:** nenhum (validação + comunicação)

- [ ] **Step 1: Suite completa de validação (o que o CI `validate` roda)**

Run (sequencial):
```bash
bun run test          # vitest — 100% verde, incluindo valor-helpers
bun run typecheck:strict
bunx tsc --noEmit
bun lint
bun build
```
Expected: tudo verde. `bun lint` sem novos erros (zero `no-explicit-any` introduzido — usar inferência/tipos concretos).

- [ ] **Step 2: `deno check` no engine (se disponível)**

Run: `deno check supabase/functions/fin-valor-engine/index.ts`
Expected: sem erros novos no arquivo (ignorar artefatos pré-existentes TS2571/TS2345/TS2578 de outras funções).

- [ ] **Step 3: Confirmar que Ondas 1-3 não regrediram**

Run: `bun run test`
Expected: os testes de `ncg-helpers`, `aging-helpers`, `dre-helpers` continuam verdes. Nenhum arquivo de produção do `fin-cashflow-engine`/`omie-financeiro` foi tocado (`git diff --stat main -- supabase/functions/fin-cashflow-engine supabase/functions/omie-financeiro` deve estar vazio).

- [ ] **Step 4: Entregar ao founder (na conversa, NÃO commitar nada além do já feito)**

   (a) **BLOCO SQL** pro SQL Editor do Lovable (idempotente — o do arquivo da Task 9, formato bloco único terminando em ``` numa linha sozinha).

   (b) **Prompt de re-deploy** pro chat do Lovable:
   > Create a new Supabase edge function named `fin-valor-engine`. Read the full code from the repo at `supabase/functions/fin-valor-engine/index.ts` on branch main and deploy it verbatim. Do NOT modify, "improve", or reinterpret the code. After deploy, confirm it shows as Active.

   (c) Lembrete: rodar o **BLOCO SQL primeiro**, depois o deploy; sem a coluna `valor_inputs` o salvar dos inputs falha (mas a leitura no engine é defensiva e o resto degrada).

- [ ] **Step 5: Finishing — usar superpowers:finishing-a-development-branch**

Apresentar ao founder as opções de integração (merge/PR). PR com nota "**ATENÇÃO: migration manual necessária**" + SQL no body. Auto/admin-merge só se o founder autorizar.

---

## Self-Review (preenchido pelo autor do plano)

**1. Cobertura do spec:**
- NOPAT regime-aware → Task 1 ✅ (corrigido pós-Codex)
- margem pré-imposto → Task 2 ✅
- capital investido (giro + AF manual − ajustes; parcial) → Task 3 ✅
- WACC hurdle (Ke decomposto + cenários, Kd pré-imposto, indisponível sem inputs) → Task 4 + engine Task 10 (cenários) ✅
- ROIC/EVA/spread → Task 5 ✅
- ROIC incremental (headline) → Task 6 + ranking na página Task 12 ✅
- normalização comingling (reportado vs normalizado) → Task 7 + engine + página ✅
- confiança/degradação → Task 8 ✅
- coluna `valor_inputs` JSONB opcional → Task 9 ✅
- engine que lê TTM DRE + NCG + inputs → Task 10 ✅
- tipos + hook `useValor` → Task 11 ✅
- rota `/financeiro/valor` + UI master-only (cards, ranking, toggle, banner, form) → Task 12 ✅
- docs CONFIABILIDADE seção A2 → Task 13 ✅
- DoD: testes verdes, validate verde, A2 não regride Ondas 1-3 → Task 14 ✅

**2. Placeholders:** nenhum "TODO/TBD"; todo step de código tem código real.

**3. Consistência de tipos:** nomes batem entre helper (Task 1-8), contrato do serviço (Task 11) e engine (Task 10): `ValorEmpresaResult.reportado.*`, `.normalizado.*`, `confianca.{nivel,motivos,*_disponivel}`, `wacc_cenarios.{conservador,base,agressivo}`, `incremental.{delta_nopat,delta_capital,aviso}`. `ValorInputs` (camelCase de campos JSONB) idem entre dialog/hook/engine (`prolabore_real_mensal`, `prolabore_mercado_mensal`, `aluguel_mercado_mensal`, `intercompany_giro`, `ke.{base,conservador,agressivo}`, `ativo_fixo.{valor,data_ref,fonte,base,operacional}`).

**Pontos de atenção pra execução (não bloqueiam o plano):**
- O link da sidebar (Task 12 Step 4) depende da estrutura real do array de itens do AppShell — o subagente deve ler a seção Financeiro existente e seguir o padrão local.
- `deno` pode não estar no PATH local; nesse caso o teste real do engine é o deploy no Lovable.
- Histórico de `fin_projecao_snapshots` < 12 meses (cron começou ~2026-05-19) → ROIC incremental degrada honesto (esperado, coberto pelo aviso).
