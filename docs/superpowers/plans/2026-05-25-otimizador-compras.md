# Otimizador de Compras — "Comprar Mais?" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enriquecer `/admin/reposicao/oportunidades` de "economia bruta" para a **decisão net-R$ marginal por SKU** ("comprar quanto, vale a pena?"), compondo dados que já existem.

**Architecture:** Helper TS puro `src/lib/reposicao/compras-otimizador-helpers.ts` (TDD, vitest) com toda a matemática marginal. **1 view** `v_otimizador_compras_insumos` (= `v_oportunidade_economica_hoje` + lote mínimo + prazo + frete; migration manual via Lovable). A página lê a view e aplica o helper **client-side** — **sem edge function** (dado operacional, RLS de staff já cobre). Frontend reusa a tabela/KPIs/drawer existentes.

**Tech Stack:** TypeScript, vitest, React + @tanstack/react-query + shadcn/ui, Supabase (Postgres view, RLS).

**Spec:** `docs/superpowers/specs/2026-05-25-otimizador-compras-design.md` (Codex-cleared, 2 passes). Ler antes de cada task.

---

## Contrato de tipos (compartilhado — Tasks 2–5)

Definidos e exportados de `src/lib/reposicao/compras-otimizador-helpers.ts`:

```typescript
export type EscopoPromo = 'sku' | 'grupo' | 'fornecedor_total';
export type RecomendacaoCompra = 'comprar_mais' | 'manter_base' | 'simulacao_parcial' | 'falta_dado';

export interface FaixaDesconto {
  volume_minimo: number;        // qtd a partir da qual o desconto vale
  desconto_promo_perc: number;  // % (ex.: 8 = 8%) — campo ATÔMICO (nunca o total somado)
  prazo_perc?: number;          // encargo(+)/desconto(−) de prazo dessa faixa, se houver
}

export interface InsumoSku {
  empresa: string; sku: string; fornecedor: string;
  preco_unit: number;                  // preco_item_eoq (preço de compra unitário, sem promo)
  demanda_diaria: number | null;
  qtde_base: number | null;            // qtde_compra_ciclo_sugerida (baseline operacional do ciclo)
  lote_minimo_fornecedor: number | null;
  minimo_forcado_manual: number | null;// extension point (§3 do spec); default null
  cm_anual: number;                    // custo de capital ANUAL como FRAÇÃO (ex.: 0.18)
  prazo_padrao_perc: number | null;    // % do prazo padrão (+encargo / −desconto); base de comparação
  frete_perc_valor: number | null;     // % sobre o valor
  frete_fixo: number | null;           // R$ fixo por pedido
  frete_taxa_pedido: number | null;    // taxa de pedido R$
  aumento_evitado_perc: number | null; // % do aumento anunciado (atômico, separado do desconto)
  dias_ate_aumento: number | null;     // dias até a vigência do aumento
  ruptura_valor_estimado: number | null; // agregado base — fase 1 só DETECTA, benefício = 0
  ruptura_dias: number | null;
  curva_desconto: FaixaDesconto[];     // 1+ faixas; fase 1 normalmente 1 (a promo ativa)
  escopo: EscopoPromo;
}

export interface DecisaoCompra {
  empresa: string; sku: string; fornecedor: string;
  q_base: number; q_candidata: number; q_extra: number; dias_cobertura_extra: number;
  desconto_rs: number; aumento_evitado_rs: number; ruptura_evitada_rs: number;
  capital_extra_rs: number; impacto_prazo_rs: number; frete_incremental_rs: number;
  beneficio_liquido_rs: number;
  recomendacao: RecomendacaoCompra;
  escopo: EscopoPromo;
  eoq_recalculo_ignorado: true;
  flags: string[];
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
}
```

---

## Task 1: View `v_otimizador_compras_insumos` (migration manual via Lovable)

**Files:**
- Create: `supabase/migrations/20260525140000_v_otimizador_compras_insumos.sql`

Reusa a `v_oportunidade_economica_hoje` (que já expõe `desconto_promo_perc`, `aumento_evitado_perc`,
`proxima_vigencia_aumento`, `qtde_base`, `demanda_diaria`, `preco_item_eoq`, `custo_capital_efetivo_perc`,
`promo_volume_minimo`) e adiciona só o que falta: `lote_minimo_fornecedor` (de `sku_parametros`), prazo
padrão (de `fornecedor_prazo_pagamento_config` onde `padrao = true`) e frete (de
`fornecedor_custo_adicional_config`).

- [ ] **Step 1: Verificar nomes exatos das colunas** no `supabase/schema-snapshot.sql`:
  - `fornecedor_prazo_pagamento_config` (~:8280): coluna do % (`desconto_ou_encargo_perc`) + flag `padrao` + chave (`fornecedor_codigo_omie`/`empresa`).
  - `fornecedor_custo_adicional_config` (~:8016): colunas de frete `% valor`, `fixo`, `taxa de pedido` + chave.
  - `sku_parametros.lote_minimo_fornecedor` (~:8876) + chave (`empresa`, `sku_codigo_omie`, `fornecedor_codigo_omie`).
  - Confirmar a semântica de `custo_capital_efetivo_perc` (anual? período?) — se vier em %/ano, o frontend
    divide por 100; se for do período de cobertura, normalizar pra anual. **Anotar no comentário da view.**

- [ ] **Step 2: Escrever a migration** (a view é `SELECT o.*` + joins; SEM regra financeira):

```sql
-- supabase/migrations/20260525140000_v_otimizador_compras_insumos.sql
-- Otimizador de Compras: view de INSUMOS (só junta fatos; nenhuma regra financeira — a matemática
-- do net-R$ marginal vive no helper TS testável). Estende v_oportunidade_economica_hoje com o lote
-- mínimo do fornecedor + prazo padrão + frete. Idempotente. security_invoker (herda RLS das fontes).
CREATE OR REPLACE VIEW v_otimizador_compras_insumos
WITH (security_invoker = on) AS
SELECT
  o.*,
  sp.lote_minimo_fornecedor,
  ppc.desconto_ou_encargo_perc        AS prazo_padrao_perc,
  cac.frete_perc_valor,
  cac.frete_fixo,
  cac.frete_taxa_pedido
FROM v_oportunidade_economica_hoje o
LEFT JOIN sku_parametros sp
  ON sp.empresa = o.empresa AND sp.sku_codigo_omie = o.sku_codigo_omie
LEFT JOIN fornecedor_prazo_pagamento_config ppc
  ON ppc.empresa = o.empresa AND ppc.fornecedor_codigo_omie = sp.fornecedor_codigo_omie AND ppc.padrao = true
LEFT JOIN fornecedor_custo_adicional_config cac
  ON cac.empresa = o.empresa AND cac.fornecedor_codigo_omie = sp.fornecedor_codigo_omie;

-- Validação
SELECT 'v_otimizador_compras_insumos OK' AS status, count(*) AS linhas FROM v_otimizador_compras_insumos;
```
⚠️ Ajustar os nomes de coluna/joins conforme o Step 1 (os acima são a intenção; o snapshot manda).
Se `fornecedor_custo_adicional_config` tiver nomes diferentes pras 3 formas de frete, mapear pra
`frete_perc_valor`/`frete_fixo`/`frete_taxa_pedido` (alias na view).

- [ ] **Step 3: Commit** (NÃO aplicar — entrega via Lovable SQL Editor na Task 6):

```bash
git add supabase/migrations/20260525140000_v_otimizador_compras_insumos.sql
git commit -m "feat(compras): view v_otimizador_compras_insumos (insumos do otimizador, sem regra)"
```

---

## Task 2: Helper — baseline, desconto aplicável, candidatos (TDD)

**Files:**
- Create: `src/lib/reposicao/compras-otimizador-helpers.ts`
- Test: `src/lib/reposicao/__tests__/compras-otimizador-helpers.test.ts`

- [ ] **Step 1: Escrever os testes (falhando)**

```typescript
import { describe, it, expect } from 'vitest';
import { qtdMinimaEfetiva, qtdBase, descontoAplicavel, gerarCandidatos } from '../compras-otimizador-helpers';

describe('qtdMinimaEfetiva', () => {
  it('max(lote, forçado)', () => {
    expect(qtdMinimaEfetiva(50, 120)).toBe(120);
    expect(qtdMinimaEfetiva(50, null)).toBe(50);
    expect(qtdMinimaEfetiva(null, null)).toBe(0);
  });
});

describe('qtdBase', () => {
  it('= max(qtde_base operacional, mínimo efetivo)', () => {
    expect(qtdBase({ qtde_base: 100, lote_minimo_fornecedor: 50, minimo_forcado_manual: null })).toBe(100);
    expect(qtdBase({ qtde_base: 100, lote_minimo_fornecedor: 50, minimo_forcado_manual: 200 })).toBe(200);
    expect(qtdBase({ qtde_base: 30, lote_minimo_fornecedor: 50, minimo_forcado_manual: null })).toBe(50);
  });
});

describe('descontoAplicavel — melhor faixa cujo volume_minimo ≤ q', () => {
  const curva = [{ volume_minimo: 100, desconto_promo_perc: 5 }, { volume_minimo: 300, desconto_promo_perc: 8 }];
  it('q abaixo de tudo → 0', () => { expect(descontoAplicavel(curva, 50)).toBe(0); });
  it('q na 1ª faixa → 5', () => { expect(descontoAplicavel(curva, 150)).toBe(5); });
  it('q na 2ª faixa → 8 (melhor)', () => { expect(descontoAplicavel(curva, 400)).toBe(8); });
});

describe('gerarCandidatos — q_base + thresholds + limites de aumento/ruptura, arredondados ao lote', () => {
  it('inclui q_base e os volume_minimo ≥ q_base', () => {
    const c = gerarCandidatos({
      q_base: 100, lote: 50, demanda_diaria: 10,
      curva: [{ volume_minimo: 100, desconto_promo_perc: 5 }, { volume_minimo: 300, desconto_promo_perc: 8 }],
      dias_ate_aumento: null, ruptura_dias: null,
    });
    expect(c).toContain(100);
    expect(c).toContain(300);
    expect(c.every((q) => q >= 100)).toBe(true);
  });
  it('inclui o limite do aumento (demanda × dias_ate_aumento) arredondado ao lote', () => {
    const c = gerarCandidatos({ q_base: 100, lote: 50, demanda_diaria: 10, curva: [], dias_ate_aumento: 30, ruptura_dias: null });
    // 10×30 = 300 → já ≥ q_base → candidato 300
    expect(c).toContain(300);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test -- compras-otimizador-helpers` → FAIL.

- [ ] **Step 3: Implementar**

```typescript
// src/lib/reposicao/compras-otimizador-helpers.ts
// Otimizador de Compras — decisão "comprar mais?" net-R$ MARGINAL por SKU. Módulo puro (TDD).
// Toda a matemática vive aqui; a view v_otimizador_compras_insumos só junta os fatos.
// Metodologia: docs/superpowers/specs/2026-05-25-otimizador-compras-design.md (Codex 2 passes).

export type EscopoPromo = 'sku' | 'grupo' | 'fornecedor_total';
export type RecomendacaoCompra = 'comprar_mais' | 'manter_base' | 'simulacao_parcial' | 'falta_dado';
export interface FaixaDesconto { volume_minimo: number; desconto_promo_perc: number; prazo_perc?: number }

export function qtdMinimaEfetiva(lote: number | null, forcado: number | null): number {
  return Math.max(lote ?? 0, forcado ?? 0);
}

export function qtdBase(input: { qtde_base: number | null; lote_minimo_fornecedor: number | null; minimo_forcado_manual: number | null }): number {
  return Math.max(input.qtde_base ?? 0, qtdMinimaEfetiva(input.lote_minimo_fornecedor, input.minimo_forcado_manual));
}

// Melhor desconto cujo volume_minimo ≤ q (curva progressiva → pega o maior aplicável).
export function descontoAplicavel(curva: FaixaDesconto[], q: number): number {
  let best = 0;
  for (const f of curva) { if (q >= f.volume_minimo && f.desconto_promo_perc > best) best = f.desconto_promo_perc; }
  return best;
}

function arredondaLote(q: number, lote: number | null): number {
  if (!lote || lote <= 0) return Math.ceil(q);
  return Math.ceil(q / lote) * lote;
}

// Candidatos: q_base + cada volume_minimo (≥ q_base) + limite do aumento + limite da ruptura, no lote.
export function gerarCandidatos(input: {
  q_base: number; lote: number | null; demanda_diaria: number | null;
  curva: FaixaDesconto[]; dias_ate_aumento: number | null; ruptura_dias: number | null;
}): number[] {
  const set = new Set<number>([input.q_base]);
  for (const f of input.curva) { const q = arredondaLote(f.volume_minimo, input.lote); if (q >= input.q_base) set.add(q); }
  const d = input.demanda_diaria ?? 0;
  if (d > 0 && input.dias_ate_aumento != null && input.dias_ate_aumento > 0) {
    const q = arredondaLote(d * input.dias_ate_aumento, input.lote); if (q >= input.q_base) set.add(q);
  }
  if (d > 0 && input.ruptura_dias != null && input.ruptura_dias > 0) {
    const q = arredondaLote(d * input.ruptura_dias, input.lote); if (q >= input.q_base) set.add(q);
  }
  return [...set].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Rodar e ver passar** — `heavy bun run test -- compras-otimizador-helpers` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/compras-otimizador-helpers.ts src/lib/reposicao/__tests__/compras-otimizador-helpers.test.ts
git commit -m "feat(compras): helper baseline + candidatos + curva de desconto (TDD)"
```

---

## Task 3: Helper — componentes do net-R$ (capital, aumento, prazo, frete, desconto) (TDD)

**Files:**
- Modify: `src/lib/reposicao/compras-otimizador-helpers.ts`
- Test: `src/lib/reposicao/__tests__/compras-otimizador-helpers.test.ts` (append)

- [ ] **Step 1: Escrever os testes (falhando)**

```typescript
import { capitalExtra, aumentoEvitadoRs, impactoPrazoRs, freteIncrementalRs, descontoIncrementalRs } from '../compras-otimizador-helpers';

describe('capitalExtra — extra carrega desde o dia 0 (cobertura do q_base + ½ da própria)', () => {
  it('fórmula = valor_extra × cm × ((q_base/d) + 0,5×(q_extra/d))/365', () => {
    // valor_extra=10000, cm=0.365 (p/ número redondo), d=10, q_base=100 (10 dias), q_extra=50 (5 dias)
    // dias efetivos = 10 + 0,5×5 = 12,5 → 10000×0,365×12,5/365 = 125
    const r = capitalExtra({ valor_extra: 10000, cm_anual: 0.365, demanda_diaria: 10, q_base: 100, q_extra: 50 });
    expect(r).toBeCloseTo(125, 2);
  });
  it('demanda 0/null → 0 (não dá pra dimensionar tempo)', () => {
    expect(capitalExtra({ valor_extra: 10000, cm_anual: 0.2, demanda_diaria: null, q_base: 100, q_extra: 50 })).toBe(0);
  });
});

describe('aumentoEvitadoRs — só a qtd consumida APÓS a vigência', () => {
  it('qtd elegível = max(0, q_cand − max(q_base, demanda×dias_ate_aumento))', () => {
    // q_base 100, demanda 10, dias_ate_aumento 30 → consumo até vigência = 300; q_cand 400 → elegível 100
    // aumento 10%, preço 50 → 100×50×0,10 = 500
    const r = aumentoEvitadoRs({ q_cand: 400, q_base: 100, demanda_diaria: 10, dias_ate_aumento: 30, aumento_perc: 10, preco_unit: 50 });
    expect(r).toBeCloseTo(500, 2);
  });
  it('sem aumento/dias → 0', () => {
    expect(aumentoEvitadoRs({ q_cand: 400, q_base: 100, demanda_diaria: 10, dias_ate_aumento: null, aumento_perc: null, preco_unit: 50 })).toBe(0);
  });
});

describe('impactoPrazoRs — (prazo_cand% − prazo_padrão%) × valor_candidato; +encargo=custo', () => {
  it('encargo maior que o padrão → custo positivo (a subtrair)', () => {
    // prazo_cand 3%, padrão 1% → delta 2% sobre valor_candidato 20000 = 400 (custo)
    const r = impactoPrazoRs({ prazo_cand_perc: 3, prazo_padrao_perc: 1, valor_candidato: 20000 });
    expect(r).toBeCloseTo(400, 2);
  });
});

describe('freteIncrementalRs — % valor + fixo + taxa de pedido sobre o incremento', () => {
  it('soma as 3 formas sobre o valor extra (fixo/taxa só se o extra gera novo pedido — fase 1: aplica no extra)', () => {
    const r = freteIncrementalRs({ valor_extra: 10000, frete_perc_valor: 2, frete_fixo: 0, frete_taxa_pedido: 0 });
    expect(r).toBeCloseTo(200, 2);
  });
});

describe('descontoIncrementalRs — desc(q_cand) − desc(q_base), campo atômico', () => {
  it('= q_cand×preço×desc%(q_cand) − q_base×preço×desc%(q_base)', () => {
    const curva = [{ volume_minimo: 100, desconto_promo_perc: 5 }, { volume_minimo: 300, desconto_promo_perc: 8 }];
    // q_base 100 (5%): 100×50×0,05=250; q_cand 300 (8%): 300×50×0,08=1200 → incremental 950
    const r = descontoIncrementalRs({ curva, q_cand: 300, q_base: 100, preco_unit: 50 });
    expect(r).toBeCloseTo(950, 2);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL.

- [ ] **Step 3: Implementar (append)**

```typescript
export function capitalExtra(input: { valor_extra: number; cm_anual: number; demanda_diaria: number | null; q_base: number; q_extra: number }): number {
  const d = input.demanda_diaria ?? 0;
  if (d <= 0) return 0;
  const diasEfetivos = (input.q_base / d) + 0.5 * (input.q_extra / d);
  return input.valor_extra * input.cm_anual * (diasEfetivos / 365);
}

export function aumentoEvitadoRs(input: { q_cand: number; q_base: number; demanda_diaria: number | null; dias_ate_aumento: number | null; aumento_perc: number | null; preco_unit: number }): number {
  const d = input.demanda_diaria ?? 0;
  if (!input.aumento_perc || input.dias_ate_aumento == null || input.dias_ate_aumento < 0) return 0;
  const consumoAteVigencia = d * input.dias_ate_aumento;
  const qElegivel = Math.max(0, input.q_cand - Math.max(input.q_base, consumoAteVigencia));
  return qElegivel * input.preco_unit * (input.aumento_perc / 100);
}

export function impactoPrazoRs(input: { prazo_cand_perc: number | null; prazo_padrao_perc: number | null; valor_candidato: number }): number {
  const cand = input.prazo_cand_perc ?? input.prazo_padrao_perc ?? 0;
  const padrao = input.prazo_padrao_perc ?? 0;
  return (cand - padrao) / 100 * input.valor_candidato; // + = encargo (custo); − = desconto (benefício)
}

export function freteIncrementalRs(input: { valor_extra: number; frete_perc_valor: number | null; frete_fixo: number | null; frete_taxa_pedido: number | null }): number {
  const perc = (input.frete_perc_valor ?? 0) / 100 * input.valor_extra;
  return perc + (input.frete_fixo ?? 0) + (input.frete_taxa_pedido ?? 0);
}

import { /* keep existing imports above */ } from './_noop'; // (no-op marker; remove — descontoAplicavel já está no arquivo)
export function descontoIncrementalRs(input: { curva: FaixaDesconto[]; q_cand: number; q_base: number; preco_unit: number }): number {
  const dCand = descontoAplicavel(input.curva, input.q_cand) / 100;
  const dBase = descontoAplicavel(input.curva, input.q_base) / 100;
  return input.q_cand * input.preco_unit * dCand - input.q_base * input.preco_unit * dBase;
}
```
⚠️ Remover a linha `import { } from './_noop'` — foi só um lembrete de que `descontoAplicavel`/`FaixaDesconto`
já estão no MESMO arquivo (Task 2); não criar `_noop`. `descontoIncrementalRs` chama `descontoAplicavel` direto.

- [ ] **Step 4: Rodar e ver passar** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/compras-otimizador-helpers.ts src/lib/reposicao/__tests__/compras-otimizador-helpers.test.ts
git commit -m "feat(compras): componentes do net-R$ (capital dia-0, aumento c/ janela, prazo, frete, desconto atômico) (TDD)"
```

---

## Task 4: Helper — `avaliarComprarMais` + `scoreConfianca` (TDD)

**Files:**
- Modify: `src/lib/reposicao/compras-otimizador-helpers.ts`
- Test: `src/lib/reposicao/__tests__/compras-otimizador-helpers.test.ts` (append)

- [ ] **Step 1: Escrever os testes (falhando)**

```typescript
import { avaliarComprarMais } from '../compras-otimizador-helpers';
import type { InsumoSku } from '../compras-otimizador-helpers';

const base: InsumoSku = {
  empresa: 'oben', sku: '123', fornecedor: 'F', preco_unit: 50, demanda_diaria: 10,
  qtde_base: 100, lote_minimo_fornecedor: 50, minimo_forcado_manual: null, cm_anual: 0.18,
  prazo_padrao_perc: 0, frete_perc_valor: 0, frete_fixo: 0, frete_taxa_pedido: 0,
  aumento_evitado_perc: null, dias_ate_aumento: null, ruptura_valor_estimado: null, ruptura_dias: null,
  curva_desconto: [{ volume_minimo: 300, desconto_promo_perc: 8 }], escopo: 'sku',
};

describe('avaliarComprarMais', () => {
  it('desconto que supera o capital extra → comprar_mais com net > 0', () => {
    const r = avaliarComprarMais(base);
    expect(r.recomendacao).toBe('comprar_mais');
    expect(r.q_candidata).toBe(300);
    expect(r.beneficio_liquido_rs).toBeGreaterThan(0);
    // desconto incremental = 300×50×0,08 = 1200; capital extra pequeno → net positivo
    expect(r.desconto_rs).toBeCloseTo(1200, 0);
  });
  it('desconto pequeno e capital alto → manter_base (nenhum candidato supera)', () => {
    const r = avaliarComprarMais({ ...base, curva_desconto: [{ volume_minimo: 300, desconto_promo_perc: 0.1 }], cm_anual: 2 });
    expect(r.recomendacao).toBe('manter_base');
    expect(r.q_candidata).toBe(r.q_base);
  });
  it('escopo grupo → simulacao_parcial mesmo com net > 0', () => {
    const r = avaliarComprarMais({ ...base, escopo: 'grupo' });
    expect(r.recomendacao).toBe('simulacao_parcial');
  });
  it('sem demanda/qtde_base → falta_dado', () => {
    const r = avaliarComprarMais({ ...base, demanda_diaria: null, qtde_base: null });
    expect(r.recomendacao).toBe('falta_dado');
  });
  it('ruptura sempre 0 na fase 1 + flag', () => {
    const r = avaliarComprarMais({ ...base, ruptura_valor_estimado: 99999, ruptura_dias: 20 });
    expect(r.ruptura_evitada_rs).toBe(0);
    expect(r.flags.join(' ')).toMatch(/ruptura/i);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL.

- [ ] **Step 3: Implementar (append)** — `InsumoSku`/`DecisaoCompra` types (do Contrato no topo do plano)
  + a composição:

```typescript
export interface InsumoSku { /* ...exatamente como no Contrato do plano... */ }
export interface DecisaoCompra { /* ...exatamente como no Contrato do plano... */ }

const DESCONTO_ALTO = 0.20;

export function avaliarComprarMais(ins: InsumoSku): DecisaoCompra {
  const flags: string[] = ['Ignora validade/obsolescência/armazém/caixa-crédito/câmbio/impostos/cesta (fase 1).'];
  const motivos: string[] = [];
  const q_base = qtdBase(ins);
  const baseVazia = (ins.demanda_diaria ?? 0) <= 0 || (ins.qtde_base ?? 0) <= 0;
  const vazio = (sku: DecisaoCompra) => sku;
  if (baseVazia) {
    return vazio({ empresa: ins.empresa, sku: ins.sku, fornecedor: ins.fornecedor, q_base, q_candidata: q_base, q_extra: 0,
      dias_cobertura_extra: 0, desconto_rs: 0, aumento_evitado_rs: 0, ruptura_evitada_rs: 0, capital_extra_rs: 0,
      impacto_prazo_rs: 0, frete_incremental_rs: 0, beneficio_liquido_rs: 0, recomendacao: 'falta_dado', escopo: ins.escopo,
      eoq_recalculo_ignorado: true, flags: [...flags, 'Sem demanda/qtde de ciclo — não dá pra dimensionar.'],
      confianca: { nivel: 'baixa', motivos: ['Faltam demanda/qtde base.'] } });
  }
  ins.ruptura_valor_estimado != null && motivos.push('Benefício de ruptura não estimado (conservador = 0).');
  flags.push('Benefício de ruptura não estimado (conservador, fase 1).');

  const candidatos = gerarCandidatos({ q_base, lote: ins.lote_minimo_fornecedor, demanda_diaria: ins.demanda_diaria,
    curva: ins.curva_desconto, dias_ate_aumento: ins.dias_ate_aumento, ruptura_dias: ins.ruptura_dias });

  let melhor: DecisaoCompra | null = null;
  for (const q_cand of candidatos) {
    const q_extra = q_cand - q_base;
    const valor_extra = q_extra * ins.preco_unit;
    const valor_candidato = q_cand * ins.preco_unit;
    const dias_cobertura_extra = (ins.demanda_diaria ?? 0) > 0 ? q_extra / (ins.demanda_diaria as number) : 0;
    const desconto_rs = descontoIncrementalRs({ curva: ins.curva_desconto, q_cand, q_base, preco_unit: ins.preco_unit });
    const aumento_evitado_rs = aumentoEvitadoRs({ q_cand, q_base, demanda_diaria: ins.demanda_diaria, dias_ate_aumento: ins.dias_ate_aumento, aumento_perc: ins.aumento_evitado_perc, preco_unit: ins.preco_unit });
    const ruptura_evitada_rs = 0; // fase 1 conservador
    const capital_extra_rs = capitalExtra({ valor_extra, cm_anual: ins.cm_anual, demanda_diaria: ins.demanda_diaria, q_base, q_extra });
    const prazo_cand_perc = descontoAplicavel(ins.curva_desconto, q_cand) > 0
      ? (ins.curva_desconto.find((f) => q_cand >= f.volume_minimo && f.prazo_perc != null)?.prazo_perc ?? ins.prazo_padrao_perc)
      : ins.prazo_padrao_perc;
    const impacto_prazo_rs = impactoPrazoRs({ prazo_cand_perc, prazo_padrao_perc: ins.prazo_padrao_perc, valor_candidato });
    const frete_incremental_rs = freteIncrementalRs({ valor_extra, frete_perc_valor: ins.frete_perc_valor, frete_fixo: ins.frete_fixo, frete_taxa_pedido: ins.frete_taxa_pedido });
    const beneficio_liquido_rs = desconto_rs + aumento_evitado_rs + ruptura_evitada_rs - capital_extra_rs - impacto_prazo_rs - frete_incremental_rs;
    const cand: DecisaoCompra = { empresa: ins.empresa, sku: ins.sku, fornecedor: ins.fornecedor, q_base, q_candidata: q_cand,
      q_extra, dias_cobertura_extra, desconto_rs, aumento_evitado_rs, ruptura_evitada_rs, capital_extra_rs, impacto_prazo_rs,
      frete_incremental_rs, beneficio_liquido_rs, recomendacao: 'manter_base', escopo: ins.escopo, eoq_recalculo_ignorado: true,
      flags, confianca: { nivel: 'alta', motivos } };
    if (!melhor || cand.beneficio_liquido_rs > melhor.beneficio_liquido_rs) melhor = cand;
  }
  const r = melhor!;
  // desconto alto sem recalcular EOQ → flag
  if (descontoAplicavel(ins.curva_desconto, r.q_candidata) / 100 > DESCONTO_ALTO) { flags.push('Desconto alto: EOQ não recalculado com preço descontado — confiança reduzida.'); motivos.push('Desconto >20% sem recálculo de EOQ.'); }
  // recomendação
  if (r.q_candidata > r.q_base && r.beneficio_liquido_rs > 0) {
    r.recomendacao = ins.escopo === 'sku' ? 'comprar_mais' : 'simulacao_parcial';
  } else {
    r.recomendacao = 'manter_base';
  }
  r.confianca = scoreConfianca({ escopo: ins.escopo, motivos });
  return r;
}

export function scoreConfianca(input: { escopo: EscopoPromo; motivos: string[] }): { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] } {
  let nivel: 'alta' | 'media' | 'baixa' = 'alta';
  if (input.escopo !== 'sku') { nivel = 'media'; }
  if (input.motivos.length > 0 && nivel === 'alta') nivel = 'media';
  return { nivel, motivos: input.motivos };
}
```
⚠️ Ao colar os tipos `InsumoSku`/`DecisaoCompra`, usar EXATAMENTE os do Contrato (topo do plano) — não
redefinir campos. Remover o helper local `vazio` se preferir retornar o objeto direto (é só clareza).

- [ ] **Step 4: Rodar e ver passar** — `heavy bun run test -- compras-otimizador-helpers` → PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/compras-otimizador-helpers.ts src/lib/reposicao/__tests__/compras-otimizador-helpers.test.ts
git commit -m "feat(compras): avaliarComprarMais (escolhe melhor candidato) + confiança (TDD)"
```

---

## Task 5: Frontend — enriquecer `AdminReposicaoOportunidades` (sem página nova)

**Files:**
- Modify: `src/pages/AdminReposicaoOportunidades.tsx` (trocar a leitura p/ `v_otimizador_compras_insumos`; aplicar o helper)
- Modify: `src/components/reposicao/oportunidades/types.ts` (estender `Oportunidade` com os campos da view + `DecisaoCompra`)
- Modify: `src/components/reposicao/oportunidades/OportunidadesTable.tsx` (coluna net-R$ + ordenação + q_base→q_candidata)
- Modify: `src/components/reposicao/oportunidades/KpiCards.tsx` (somar net-R$)
- Modify: `src/components/reposicao/oportunidades/components.tsx` (drawer: decomposição R$)

- [ ] **Step 1: Estender os tipos** em `types.ts`: adicionar à `Oportunidade` os campos novos da view
  (`lote_minimo_fornecedor`, `prazo_padrao_perc`, `frete_perc_valor`, `frete_fixo`, `frete_taxa_pedido`,
  `promo_volume_minimo`) e importar `DecisaoCompra` do helper. Criar `OportunidadeComDecisao = Oportunidade & { decisao: DecisaoCompra }`.

- [ ] **Step 2: Na página**, trocar `.from("v_oportunidade_economica_hoje")` por `.from("v_otimizador_compras_insumos")`
  (mesmo shape + colunas novas). Após buscar, mapear cada linha → `InsumoSku` e chamar `avaliarComprarMais`:
  - `preco_unit = preco_item_eoq`; `cm_anual = custo_capital_efetivo_perc` **normalizado pra fração**
    (confirmar semântica na Task 1 — se vier em %/ano, dividir por 100);
  - `dias_ate_aumento = diasEntre(proxima_vigencia_aumento)` (helper de `shared.tsx`);
  - `curva_desconto = [{ volume_minimo: promo_volume_minimo ?? 0, desconto_promo_perc: desconto_promo_perc ?? 0 }]`
    (filtrar faixas com desconto 0); `escopo = 'sku'` (fase 1; quando a promo for de grupo, marcar — fora do escopo agora).
  Guardar `decisao` em cada item. Mudar a ordenação default `"economia"` p/ usar `decisao.beneficio_liquido_rs`.

- [ ] **Step 3: `OportunidadesTable`** — adicionar coluna **"Net R$"** (`decisao.beneficio_liquido_rs`, `formatBRL`,
  classe `text-status-success` se >0 / `text-status-error` se <0), coluna **"Comprar"** (`q_base → q_candidata`),
  e badge de `decisao.recomendacao`. Manter a coluna de economia bruta. Ordenação por net.

- [ ] **Step 4: `KpiCards`** — novo KPI "Ganho líquido potencial" = `Σ decisao.beneficio_liquido_rs` dos itens
  com `recomendacao === 'comprar_mais'`. Manter o KPI de economia bruta.

- [ ] **Step 5: Drawer (`components.tsx` / `DrawerConteudo`)** — bloco "Decisão: comprar mais?" com a
  **decomposição R$**: `+ desconto`, `+ aumento evitado`, `+ ruptura evitada`, `− capital extra`,
  `− prazo`, `− frete` = **net**; e `q_base → q_candidata` (quanto comprar). Listar `decisao.flags`.
  Cores `text-status-*`; nunca emerald/red-600.

- [ ] **Step 6: Typecheck + build + commit**

```bash
heavy bun run typecheck:strict 2>/dev/null || bunx tsc --noEmit
heavy bun run build 2>&1 | tail -3
git add src/pages/AdminReposicaoOportunidades.tsx src/components/reposicao/oportunidades/
git commit -m "feat(compras): Oportunidades mostra decisão net-R$ marginal (coluna/KPI/drawer)"
```

---

## Task 6: Docs + validação + revisão Codex + entregáveis + PR

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md` (ou um doc de Reposição) — seção "Otimizador de Compras"
- Regenerar: `bun run audit:migrations`

- [ ] **Step 1: Doc** — seção curta: o que faz (net-R$ marginal "comprar mais?"), metodologia (baseline
  qtde_base, candidatos, capital dia-0, aumento c/ janela, ruptura conservadora=0, desconto atômico,
  prazo vs padrão, frete 3-formas), degradação/flags, e que mora na Oportunidades (sem página nova).
  Listar a migration manual da view + o ponto de extensão do mínimo forçado.

- [ ] **Step 2: Suite + lint**

```bash
heavy bun run test 2>&1 | tail -8        # os ~28-32 testes do helper + suite verde
heavy bun lint 2>&1 | tail -10           # sem erro novo nos arquivos da feature
```

- [ ] **Step 3: Regenerar audit + commit**

```bash
bun run audit:migrations
git add docs/FINANCEIRO_CONFIABILIDADE.md docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "docs(compras): seção otimizador + audit de migrations"
```

- [ ] **Step 4: Revisão adversária Codex**

```bash
codex exec "Revise a implementação do otimizador de compras: src/lib/reposicao/compras-otimizador-helpers.ts + os testes + a integração em AdminReposicaoOportunidades. Foque em: (1) a fórmula do capital_extra (extra carrega desde o dia 0); (2) desconto/aumento de campos atômicos (sem double-count com economia_bruta); (3) aumento com janela temporal; (4) ruptura=0 conservador; (5) escolha do melhor candidato; (6) escopo grupo→simulacao_parcial; (7) normalização do custo de capital (fração vs %). Aponte só o que está ERRADO. Conciso, em português." -C $(pwd) -s read-only -c 'model_reasoning_effort="high"' 2>&1 | tail -50
```
Incorporar P1/P2; re-rodar testes; commit dos fixes.

- [ ] **Step 5: Entregáveis Lovable (usar skill `lovable-db-operator`) + Push + PR** (quando o founder autorizar)
  - Entregar o bloco SQL da view `v_otimizador_compras_insumos` (com a query de validação) pro SQL Editor.
  - `git push -u origin feat/otimizador-compras` + `gh pr create` com nota **"ATENÇÃO: migration manual
    (view) necessária"** + o SQL no corpo. **Sem deploy de edge function** (não há).

---

## Self-Review
- **Cobertura do spec:** §2 metodologia → Tasks 2-4; §3 mínimo forçado → `qtdBase`/`qtdMinimaEfetiva` (Task 2);
  §4 arquitetura (helper + view, sem edge fn) → Tasks 1-2; §5 contrato → Contrato + Tasks 2-4; §6 frontend → Task 5;
  §7 degradação → `avaliarComprarMais`/`scoreConfianca` (Task 4); §8 testes → Tasks 2-4; §10 validação → Task 6. ✅
- **Placeholders:** o único ponto sem SQL literal é a view (Task 1) — proposital: os nomes exatos vêm do
  `schema-snapshot.sql` (Step 1 instrui a verificar). Helper tem código+testes completos.
- **Consistência de tipos:** `FaixaDesconto`/`InsumoSku`/`DecisaoCompra` definidos no Contrato e reusados;
  funções `qtdBase`/`descontoAplicavel`/`gerarCandidatos`/`capitalExtra`/`aumentoEvitadoRs`/`impactoPrazoRs`/
  `freteIncrementalRs`/`descontoIncrementalRs`/`avaliarComprarMais`/`scoreConfianca` com nomes idênticos entre tasks.
