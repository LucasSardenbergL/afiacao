# F1 Módulo de Endividamento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cadastro manual master-only de dívidas + indicadores de endividamento (serviço da dívida, DSCR-caixa, % curto prazo) que fecham os erros 1/8/9 da matéria PEGN, sem fabricar número.

**Architecture:** Helper TS puro (`endividamento-helpers.ts`, vitest) calcula todos os indicadores; 3 tabelas `fin_*` master-only guardam o cadastro; o DSCR só publica com flag de inclusão-no-CP + gate de completude (add-back analítico desfaz o double-count com o A1). O serviço da dívida é overlay analítico ancorado na projeção 13 semanas — nunca reescreve o `fin-cashflow-engine`.

**Tech Stack:** React 18 + TS 5.8 strict, Vite, @tanstack/react-query, Supabase (Lovable Cloud), vitest, PostgreSQL 17 (prova local via prove-sql-money-path).

**Spec:** `docs/superpowers/specs/2026-07-04-endividamento-dscr-design.md`

---

## File Structure

- `src/lib/financeiro/endividamento-types.ts` — tipos (Divida, Parcela, resultados)
- `src/lib/financeiro/endividamento-helpers.ts` — helper puro (indicadores)
- `src/lib/financeiro/__tests__/endividamento-helpers.test.ts` — vitest
- `supabase/migrations/20260704160000_fin_dividas.sql` — 3 tabelas + RLS + triggers
- `db/test-endividamento-money-path.sh` — prova PG17 (constraints + RLS)
- `src/hooks/useEndividamento.ts` — CRUD react-query
- `src/pages/FinanceiroEndividamento.tsx` — página master-only
- `src/components/financeiro/endividamento/*` — formulário + tabela de indicadores + faixa DSCR
- `src/App.tsx` — rota lazy

---

## Task 1: Tipos + serviço da dívida (buckets vencido/a-vencer)

**Files:**
- Create: `src/lib/financeiro/endividamento-types.ts`
- Create: `src/lib/financeiro/endividamento-helpers.ts`
- Test: `src/lib/financeiro/__tests__/endividamento-helpers.test.ts`

- [ ] **Step 1: Criar os tipos**

Create `src/lib/financeiro/endividamento-types.ts`:

```typescript
export type Company = 'oben' | 'colacor' | 'colacor_sc';
export type TipoDivida = 'capital_giro' | 'financiamento' | 'antecipacao_recorrente' | 'outro';
export type CpInclusionStatus = 'sim' | 'nao' | 'parcial' | 'nao_sei';

export interface Divida {
  id: string;
  company: Company;
  credor: string;
  tipo: TipoDivida;
  principal_contratado: number;
  saldo_devedor_informado: number | null;
  saldo_devedor_data_base: string | null; // ISO YYYY-MM-DD
  cp_inclusion_status: CpInclusionStatus;
  cp_inclusion_ate: string | null;
  data_contratacao: string;
  cet_aa: number | null;
  indexador: string | null;
  coobrigada_por: Company | null;
  garantias: string | null;
  observacao: string | null;
  ativo: boolean;
}

export interface Parcela {
  id: string;
  divida_id: string;
  numero_parcela: number;
  data_vencimento: string; // ISO YYYY-MM-DD (comparável lexicograficamente)
  valor_amortizacao: number;
  valor_juros: number;
  valor_total: number;
  estimado: boolean;
  pago: boolean;
}

export interface ServicoDivida {
  vencido: number; // não-pago, vencimento < hoje (pressão represada)
  aVencer: number; // não-pago, hoje <= vencimento <= fim
  total: number;   // vencido + aVencer
}

export type DscrMotivo = 'ok' | 'inconclusivo' | 'sem_divida' | 'sem_geracao';
export interface DscrResult {
  valor: number | null;
  motivo: DscrMotivo;
}

export interface IndicadorEbitda {
  valor: number | null;
  motivo: 'ok' | 'falta_ebitda' | 'sem_divida';
}
```

- [ ] **Step 2: Escrever o teste que falha — serviço da dívida**

Create `src/lib/financeiro/__tests__/endividamento-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { servicoDivida } from '../endividamento-helpers';
import type { Divida, Parcela } from '../endividamento-types';

const divida = (over: Partial<Divida>): Divida => ({
  id: 'd1', company: 'oben', credor: 'Banco X', tipo: 'financiamento',
  principal_contratado: 100000, saldo_devedor_informado: null, saldo_devedor_data_base: null,
  cp_inclusion_status: 'nao', cp_inclusion_ate: null, data_contratacao: '2025-01-01',
  cet_aa: null, indexador: null, coobrigada_por: null, garantias: null, observacao: null,
  ativo: true, ...over,
});
const parc = (over: Partial<Parcela>): Parcela => ({
  id: 'p1', divida_id: 'd1', numero_parcela: 1, data_vencimento: '2026-08-01',
  valor_amortizacao: 900, valor_juros: 100, valor_total: 1000, estimado: false, pago: false, ...over,
});

describe('servicoDivida', () => {
  const hoje = '2026-07-04';
  const fim = '2026-10-03'; // ~13 semanas

  it('separa vencido (antes de hoje) de a-vencer (dentro do horizonte)', () => {
    const d = [divida({ id: 'd1' })];
    const ps = [
      parc({ id: 'a', data_vencimento: '2026-06-01', valor_total: 500 }), // vencido
      parc({ id: 'b', data_vencimento: '2026-08-01', valor_total: 1000 }), // a vencer
      parc({ id: 'c', data_vencimento: '2027-01-01', valor_total: 9999 }), // fora do horizonte
    ];
    expect(servicoDivida(d, ps, hoje, fim)).toEqual({ vencido: 500, aVencer: 1000, total: 1500 });
  });

  it('ignora parcela paga', () => {
    const d = [divida({ id: 'd1' })];
    const ps = [parc({ data_vencimento: '2026-08-01', valor_total: 1000, pago: true })];
    expect(servicoDivida(d, ps, hoje, fim)).toEqual({ vencido: 0, aVencer: 0, total: 0 });
  });

  it('exclui antecipacao_recorrente do serviço', () => {
    const d = [divida({ id: 'd1', tipo: 'antecipacao_recorrente' })];
    const ps = [parc({ divida_id: 'd1', data_vencimento: '2026-08-01', valor_total: 1000 })];
    expect(servicoDivida(d, ps, hoje, fim)).toEqual({ vencido: 0, aVencer: 0, total: 0 });
  });
});
```

- [ ] **Step 3: Rodar o teste e ver falhar**

Run: `heavy bun run test -- endividamento-helpers`
Expected: FAIL — `servicoDivida is not a function` / módulo não existe.

- [ ] **Step 4: Implementar `servicoDivida`**

Create `src/lib/financeiro/endividamento-helpers.ts`:

```typescript
import type { Divida, Parcela, ServicoDivida } from './endividamento-types';

/**
 * Serviço da dívida no horizonte [hoje, fim], em dois buckets.
 * Datas ISO YYYY-MM-DD comparadas lexicograficamente (datas puras, sem TZ).
 * Exclui antecipacao_recorrente (natureza rolling — entra à parte, nunca no DSCR).
 * `dividas` é o SUBCONJUNTO a somar (total, ou add-back das 'sim').
 */
export function servicoDivida(
  dividas: Pick<Divida, 'id' | 'tipo'>[],
  parcelas: Parcela[],
  hojeISO: string,
  fimISO: string,
): ServicoDivida {
  const ids = new Set(
    dividas.filter((d) => d.tipo !== 'antecipacao_recorrente').map((d) => d.id),
  );
  let vencido = 0;
  let aVencer = 0;
  for (const p of parcelas) {
    if (p.pago || !ids.has(p.divida_id)) continue;
    if (!Number.isFinite(p.valor_total)) continue;
    if (p.data_vencimento < hojeISO) vencido += p.valor_total;
    else if (p.data_vencimento <= fimISO) aVencer += p.valor_total;
  }
  return { vencido, aVencer, total: vencido + aVencer };
}
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `heavy bun run test -- endividamento-helpers`
Expected: PASS (3 testes).

- [ ] **Step 6: Commit**

```bash
git add src/lib/financeiro/endividamento-types.ts src/lib/financeiro/endividamento-helpers.ts src/lib/financeiro/__tests__/endividamento-helpers.test.ts
git commit -m "feat(financeiro): serviço da dívida com buckets vencido/a-vencer (F1)"
```

---

## Task 2: DSCR-caixa (gate de completude + add-back)

**Files:**
- Modify: `src/lib/financeiro/endividamento-helpers.ts`
- Test: `src/lib/financeiro/__tests__/endividamento-helpers.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Append to the test file:

```typescript
import { dscrCaixa } from '../endividamento-helpers';

describe('dscrCaixa', () => {
  const hoje = '2026-07-04';
  const fim = '2026-10-03';
  const base = (over: Partial<Divida>) => divida({ id: 'd1', cp_inclusion_status: 'sim', ...over });
  const parcela = parc({ divida_id: 'd1', data_vencimento: '2026-08-01', valor_total: 1000 });

  it('não publica sem gate de completude (inconclusivo)', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({})], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: false });
    expect(r).toEqual({ valor: null, motivo: 'inconclusivo' });
  });

  it('não publica quando alguma dívida ativa é nao_sei', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({ cp_inclusion_status: 'nao_sei' })], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r).toEqual({ valor: null, motivo: 'inconclusivo' });
  });

  it('add-back: dívida no CP soma o serviço de volta ao numerador', () => {
    // geração A1 = 5000 (já deduziu a parcela de 1000 do CP); add-back devolve → num 6000; den 1000 → DSCR 6
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({ cp_inclusion_status: 'sim' })], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r.motivo).toBe('ok');
    expect(r.valor).toBeCloseTo(6, 9);
  });

  it('dívida fora do CP (nao): sem add-back → num 5000; den 1000 → DSCR 5', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({ cp_inclusion_status: 'nao' })], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r.valor).toBeCloseTo(5, 9);
  });

  it('sem dívida no horizonte → null/sem_divida', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({})], parcelas: [], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r).toEqual({ valor: null, motivo: 'sem_divida' });
  });

  it('geração ausente → null/sem_geracao, nunca 0', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: null, dividas: [base({})], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r).toEqual({ valor: null, motivo: 'sem_geracao' });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- endividamento-helpers`
Expected: FAIL — `dscrCaixa is not a function`.

- [ ] **Step 3: Implementar `dscrCaixa`**

Append to `endividamento-helpers.ts`:

```typescript
import type { DscrResult } from './endividamento-types';

/**
 * DSCR-caixa. Publica SÓ com gate de completude e nenhuma dívida ativa 'nao_sei'
 * (denominador incompleto vira índice falso — Codex P1). Add-back: as dívidas com
 * cp_inclusion_status='sim' já foram descontadas pelo A1; devolvê-las ao numerador
 * dá o "cash available for debt service" limpo.
 */
export function dscrCaixa(params: {
  geracaoOperacionalA1: number | null;
  dividas: Divida[];
  parcelas: Parcela[];
  hojeISO: string;
  fimISO: string;
  completo: boolean;
}): DscrResult {
  const { geracaoOperacionalA1, dividas, parcelas, hojeISO, fimISO, completo } = params;
  const ativas = dividas.filter((d) => d.ativo);
  const temNaoSei = ativas.some((d) => d.cp_inclusion_status === 'nao_sei');
  if (!completo || temNaoSei) return { valor: null, motivo: 'inconclusivo' };

  const servicoTotal = servicoDivida(ativas, parcelas, hojeISO, fimISO).total;
  if (!(servicoTotal > 0)) return { valor: null, motivo: 'sem_divida' };
  if (geracaoOperacionalA1 == null || !Number.isFinite(geracaoOperacionalA1)) {
    return { valor: null, motivo: 'sem_geracao' };
  }
  const dividasSim = ativas.filter((d) => d.cp_inclusion_status === 'sim');
  const addBack = servicoDivida(dividasSim, parcelas, hojeISO, fimISO).total;
  return { valor: (geracaoOperacionalA1 + addBack) / servicoTotal, motivo: 'ok' };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test -- endividamento-helpers`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/endividamento-helpers.ts src/lib/financeiro/__tests__/endividamento-helpers.test.ts
git commit -m "feat(financeiro): DSCR-caixa com gate de completude + add-back (F1)"
```

---

## Task 3: Saldo devedor + % curto prazo

**Files:**
- Modify: `src/lib/financeiro/endividamento-helpers.ts`
- Test: `src/lib/financeiro/__tests__/endividamento-helpers.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Append:

```typescript
import { saldoDevedorEmAberto, pctCurtoPrazo } from '../endividamento-helpers';

describe('saldoDevedorEmAberto', () => {
  it('usa saldo_devedor_informado quando presente', () => {
    const d = divida({ id: 'd1', saldo_devedor_informado: 42000 });
    expect(saldoDevedorEmAberto(d, [])).toBe(42000);
  });
  it('deriva da amortização não paga quando ausente', () => {
    const d = divida({ id: 'd1', saldo_devedor_informado: null });
    const ps = [
      parc({ divida_id: 'd1', valor_amortizacao: 900, pago: false }),
      parc({ id: 'p2', divida_id: 'd1', valor_amortizacao: 900, pago: true }), // paga não conta
    ];
    expect(saldoDevedorEmAberto(d, ps)).toBe(900);
  });
});

describe('pctCurtoPrazo', () => {
  const hoje = '2026-07-04';
  const ate12m = '2027-07-04';
  it('amortização até 12m (inclui vencido) ÷ saldo em aberto', () => {
    const d = [divida({ id: 'd1', saldo_devedor_informado: 10000 })];
    const ps = [
      parc({ id: 'a', divida_id: 'd1', data_vencimento: '2026-05-01', valor_amortizacao: 1000 }), // vencido
      parc({ id: 'b', divida_id: 'd1', data_vencimento: '2027-01-01', valor_amortizacao: 2000 }), // <=12m
      parc({ id: 'c', divida_id: 'd1', data_vencimento: '2028-01-01', valor_amortizacao: 5000 }), // >12m
    ];
    expect(pctCurtoPrazo(d, ps, hoje, ate12m)).toBeCloseTo(0.3, 9); // (1000+2000)/10000
  });
  it('saldo total 0 → null (não divide por zero)', () => {
    expect(pctCurtoPrazo([divida({ saldo_devedor_informado: 0 })], [], hoje, ate12m)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- endividamento-helpers`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Append:

```typescript
export function saldoDevedorEmAberto(divida: Divida, parcelas: Parcela[]): number {
  const inf = divida.saldo_devedor_informado;
  if (inf != null && Number.isFinite(inf)) return inf;
  return parcelas
    .filter((p) => p.divida_id === divida.id && !p.pago && Number.isFinite(p.valor_amortizacao))
    .reduce((s, p) => s + p.valor_amortizacao, 0);
}

/** % de curto prazo = amortização vencida + a vencer em ≤12m ÷ saldo devedor em aberto. */
export function pctCurtoPrazo(
  dividas: Divida[],
  parcelas: Parcela[],
  hojeISO: string,
  ate12mISO: string,
): number | null {
  const ativas = dividas.filter((d) => d.ativo);
  const ids = new Set(ativas.map((d) => d.id));
  const saldoTotal = ativas.reduce((s, d) => s + saldoDevedorEmAberto(d, parcelas), 0);
  if (!(saldoTotal > 0)) return null;
  let curto = 0;
  for (const p of parcelas) {
    if (p.pago || !ids.has(p.divida_id)) continue;
    if (!Number.isFinite(p.valor_amortizacao)) continue;
    if (p.data_vencimento <= ate12mISO) curto += p.valor_amortizacao; // ≤12m já cobre vencido
  }
  return curto / saldoTotal;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test -- endividamento-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/endividamento-helpers.ts src/lib/financeiro/__tests__/endividamento-helpers.test.ts
git commit -m "feat(financeiro): saldo devedor em aberto + % curto prazo (F1)"
```

---

## Task 4: DSCR-EBITDA + dívida líquida/EBITDA (degradam sem D&A)

**Files:**
- Modify: `src/lib/financeiro/endividamento-helpers.ts`
- Test: `src/lib/financeiro/__tests__/endividamento-helpers.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Append:

```typescript
import { dscrEbitda, dividaLiquidaEbitda } from '../endividamento-helpers';

describe('indicadores EBITDA (degradam sem D&A)', () => {
  it('dscrEbitda: EBITDA null → null/falta_ebitda (nunca 0)', () => {
    expect(dscrEbitda(null, 12000)).toEqual({ valor: null, motivo: 'falta_ebitda' });
  });
  it('dscrEbitda: caso feliz', () => {
    expect(dscrEbitda(120000, 60000).valor).toBeCloseTo(2, 9);
  });
  it('dividaLiquidaEbitda: EBITDA 0 → null (não fabrica ∞)', () => {
    expect(dividaLiquidaEbitda(500000, 100000, 0)).toEqual({ valor: null, motivo: 'falta_ebitda' });
  });
  it('dividaLiquidaEbitda: (bruta − caixa)/ebitda', () => {
    expect(dividaLiquidaEbitda(500000, 100000, 200000).valor).toBeCloseTo(2, 9);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- endividamento-helpers`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Append:

```typescript
import type { IndicadorEbitda } from './endividamento-types';

export function dscrEbitda(ebitda: number | null, servicoDividaLTM: number): IndicadorEbitda {
  if (ebitda == null || !Number.isFinite(ebitda)) return { valor: null, motivo: 'falta_ebitda' };
  if (!(servicoDividaLTM > 0)) return { valor: null, motivo: 'sem_divida' };
  return { valor: ebitda / servicoDividaLTM, motivo: 'ok' };
}

export function dividaLiquidaEbitda(
  dividaBruta: number,
  caixa: number,
  ebitda: number | null,
): IndicadorEbitda {
  if (ebitda == null || !Number.isFinite(ebitda) || ebitda === 0) {
    return { valor: null, motivo: 'falta_ebitda' };
  }
  return { valor: (dividaBruta - caixa) / ebitda, motivo: 'ok' };
}
```

- [ ] **Step 4: Rodar e ver passar + typecheck**

Run: `heavy bun run test -- endividamento-helpers && heavy bun run typecheck`
Expected: PASS + typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/endividamento-helpers.ts src/lib/financeiro/__tests__/endividamento-helpers.test.ts
git commit -m "feat(financeiro): DSCR-EBITDA e dívida/EBITDA degradam sem D&A (F1)"
```

---

## Task 5: Migration — 3 tabelas + RLS master-only + triggers

**Files:**
- Create: `supabase/migrations/20260704160000_fin_dividas.sql`

Este task usa a skill **lovable-db-operator** para empacotar o handoff (arquivo + bloco SQL Editor + validação pós-apply + nota PR). O SQL abaixo é o conteúdo da migration.

- [ ] **Step 1: Escrever a migration**

Create `supabase/migrations/20260704160000_fin_dividas.sql`:

```sql
-- ============================================================
-- F1 Módulo de Endividamento — cadastro manual master-only.
-- Spec: docs/superpowers/specs/2026-07-04-endividamento-dscr-design.md
-- RLS master-only (padrão fin_balanco_inputs). Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fin_dividas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  credor text NOT NULL CHECK (btrim(credor) <> ''),
  tipo text NOT NULL CHECK (tipo IN ('capital_giro','financiamento','antecipacao_recorrente','outro')),
  principal_contratado numeric(15,2) NOT NULL CHECK (principal_contratado > 0),
  saldo_devedor_informado numeric(15,2) CHECK (saldo_devedor_informado IS NULL OR saldo_devedor_informado >= 0),
  saldo_devedor_data_base date,
  cp_inclusion_status text NOT NULL DEFAULT 'nao_sei' CHECK (cp_inclusion_status IN ('sim','nao','parcial','nao_sei')),
  cp_inclusion_ate date,
  data_contratacao date NOT NULL,
  cet_aa numeric(7,4) CHECK (cet_aa IS NULL OR cet_aa >= 0),
  indexador text,
  coobrigada_por text CHECK (coobrigada_por IS NULL OR coobrigada_por IN ('oben','colacor','colacor_sc')),
  garantias text,
  observacao text,
  ativo boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
COMMENT ON TABLE public.fin_dividas IS
  'Cadastro manual master-only de dívidas (F1). cp_inclusion_status decide overlay vs add-back no DSCR.';

CREATE TABLE IF NOT EXISTS public.fin_divida_parcelas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  divida_id uuid NOT NULL REFERENCES public.fin_dividas(id) ON DELETE CASCADE,
  numero_parcela int NOT NULL CHECK (numero_parcela > 0),
  data_vencimento date NOT NULL,
  valor_amortizacao numeric(15,2) NOT NULL CHECK (valor_amortizacao >= 0),
  valor_juros numeric(15,2) NOT NULL DEFAULT 0 CHECK (valor_juros >= 0),
  valor_total numeric(15,2) NOT NULL CHECK (valor_total > 0),
  estimado boolean NOT NULL DEFAULT false,
  pago boolean NOT NULL DEFAULT false,
  CONSTRAINT fin_divida_parcelas_uq UNIQUE (divida_id, numero_parcela)
);
CREATE INDEX IF NOT EXISTS idx_fin_divida_parcelas_venc ON public.fin_divida_parcelas(divida_id, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_fin_divida_parcelas_naopago ON public.fin_divida_parcelas(divida_id) WHERE pago = false;

CREATE TABLE IF NOT EXISTS public.fin_divida_completude (
  company text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  completo boolean NOT NULL DEFAULT false,
  validado_em timestamptz,
  validado_por uuid
);
COMMENT ON TABLE public.fin_divida_completude IS
  'Gate de completude por empresa: sem completo=true o DSCR não publica (denominador incompleto = índice falso).';

-- Trigger de autor/timestamp forçados no servidor (default auth.uid() é forjável).
CREATE OR REPLACE FUNCTION public.fin_dividas_forca_autor()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN NEW.updated_by := auth.uid(); END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_fin_dividas_autor ON public.fin_dividas;
CREATE TRIGGER trg_fin_dividas_autor BEFORE INSERT OR UPDATE ON public.fin_dividas
  FOR EACH ROW EXECUTE FUNCTION public.fin_dividas_forca_autor();

CREATE OR REPLACE FUNCTION public.fin_divida_completude_forca_autor()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN NEW.validado_por := auth.uid(); END IF;
  NEW.validado_em := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_fin_divida_completude_autor ON public.fin_divida_completude;
CREATE TRIGGER trg_fin_divida_completude_autor BEFORE INSERT OR UPDATE ON public.fin_divida_completude
  FOR EACH ROW EXECUTE FUNCTION public.fin_divida_completude_forca_autor();

-- RLS master-only (padrão fin_balanco_inputs) para as 3 tabelas.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_dividas','fin_divida_parcelas','fin_divida_completude'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select_master ON public.%I', t, t);
    EXECUTE format($p$CREATE POLICY %I_select_master ON public.%I FOR SELECT USING (
      (SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid()) AND role = 'master'::public.app_role)))$p$, t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write_master ON public.%I', t, t);
    EXECUTE format($p$CREATE POLICY %I_write_master ON public.%I USING (
      (SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid()) AND role = 'master'::public.app_role)))
      WITH CHECK (
      (SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid()) AND role = 'master'::public.app_role)))$p$, t, t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Validação pós-apply (query read-only)**

Guardar para rodar via `psql-ro` após o founder colar no SQL Editor:

```sql
SELECT tablename FROM pg_tables WHERE tablename IN ('fin_dividas','fin_divida_parcelas','fin_divida_completude');
SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('fin_dividas','fin_divida_parcelas','fin_divida_completude');
```
Expected: 3 tabelas, `relrowsecurity = t` nas 3.

- [ ] **Step 3: Regenerar o audit + commit**

```bash
bun run audit:migrations
git add supabase/migrations/20260704160000_fin_dividas.sql docs/migrations-audit.md
git commit -m "feat(db): tabelas fin_dividas/parcelas/completude master-only (F1) — migration manual"
```

---

## Task 6: Prova PG17 (prove-sql-money-path)

**Files:**
- Create: `db/test-endividamento-money-path.sh`

Usar a skill **prove-sql-money-path** para montar o harness PG17. Asserts obrigatórios:

- [ ] **Step 1: Escrever o harness com os asserts**

Cobrir (cada um com assert + falsificação onde indicado):
1. Constraints: `principal_contratado <= 0` → rejeitado (23514); `valor_total <= 0` → rejeitado; `tipo`/`company`/`cp_inclusion_status` fora do enum → rejeitado; UNIQUE `(divida_id, numero_parcela)` duplicado → 23505; `ON DELETE CASCADE` apaga parcelas ao deletar a dívida.
2. Trigger: INSERT com `updated_by` forjado (outro uuid) sob `auth.uid()` setado → o trigger sobrescreve para `auth.uid()`.
3. RLS: sob `SET ROLE authenticated` + GUC de um não-master → SELECT retorna 0 linhas; INSERT → 42501. Sob GUC de master → passa. (psql é superuser → obrigatório `SET ROLE` + GUC do JWT, senão bypassa.)
4. **Falsificação:** sabotar o CHECK de `valor_total` (`> 0` → `>= -1`) → o assert de rejeição fica vermelho; restaurar → verde.

- [ ] **Step 2: Rodar o harness**

Run: `bash db/test-endividamento-money-path.sh > /tmp/prove.log 2>&1; echo $?`
Expected: exit 0, todos os asserts verdes; a rodada de falsificação prova vermelho→verde.

- [ ] **Step 3: Commit**

```bash
git add db/test-endividamento-money-path.sh
git commit -m "test(db): prova PG17 das constraints + RLS de fin_dividas (F1)"
```

---

## Task 7: Hook de dados `useEndividamento`

**Files:**
- Create: `src/hooks/useEndividamento.ts`

- [ ] **Step 1: Implementar o hook (react-query)**

`useEndividamento(company)` expõe:
- `dividas` (query `fin_dividas` por company, `.order('credor')`)
- `parcelas` (query `fin_divida_parcelas` das dívidas da company)
- `completude` (query `fin_divida_completude` por company)
- mutations: `upsertDivida`, `deleteDivida`, `upsertParcela`, `marcarCompleto(bool)`
- `staleTime: 60_000`, invalidação por `queryKey ['endividamento', company]` após mutation.

Padrão: seguir `useFunding.ts` (mesmo diretório) para o shape do hook e o tratamento de erro. Master-only já garantido pela RLS; o hook não precisa gatear (fail-closed no banco).

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck`
Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useEndividamento.ts
git commit -m "feat(financeiro): hook useEndividamento (CRUD react-query) (F1)"
```

---

## Task 8: UI — formulário de cadastro

**Files:**
- Create: `src/components/financeiro/endividamento/DividaFormDialog.tsx`
- Create: `src/components/financeiro/endividamento/ParcelasEditor.tsx`

- [ ] **Step 1: Formulário de dívida (react-hook-form + zod)**

Campos da `fin_dividas`. Destaque para o campo **`cp_inclusion_status`** (radio: "já está no meu contas-a-pagar do Omie? sim / não / parcial / não sei") com texto explicativo curto — é o clique que resolve o double-count. `coobrigada_por` opcional com aviso "só preencha se outra empresa avaliza". Validação zod: `principal_contratado > 0`, `credor` não-vazio, `tipo`/`company` no enum.

- [ ] **Step 2: Editor de parcelas**

Tabela editável (nº, vencimento, amortização, juros, total, estimado, pago). Botão "gerar parcelas" (helper client que distribui em N meses a partir de uma data — só conveniência, o founder ajusta). Alerta suave inline quando `valor_total < valor_amortizacao + valor_juros`.

- [ ] **Step 3: Typecheck + commit**

```bash
heavy bun run typecheck
git add src/components/financeiro/endividamento/DividaFormDialog.tsx src/components/financeiro/endividamento/ParcelasEditor.tsx
git commit -m "feat(financeiro): formulário de cadastro de dívida + parcelas (F1)"
```

---

## Task 9: UI — página + indicadores + faixa DSCR na projeção

**Files:**
- Create: `src/pages/FinanceiroEndividamento.tsx`
- Create: `src/components/financeiro/endividamento/IndicadoresEndividamento.tsx`
- Modify: `src/App.tsx` (rota lazy)

- [ ] **Step 1: Página master-only**

`FinanceiroEndividamento.tsx`: seletor de empresa, lista de dívidas (com badge do `cp_inclusion_status`), botão "marcar cadastro completo" (grava `fin_divida_completude`), e o painel de indicadores. Master-only: se `!isMaster`, `<EmptyState tone="operational">` "acesso restrito". Usa `useEndividamento`.

- [ ] **Step 2: Painel de indicadores**

`IndicadoresEndividamento.tsx` consome o helper. Mostra:
- Serviço da dívida: **vencido** (destaque `text-status-error` se >0) + **a vencer 13s** + total.
- **DSCR-caixa**: se `motivo==='ok'` mostra o índice com faixa de cor (`<1` error, `1–1.2` warning, `>1.2` success); se `inconclusivo`, mostra card neutro "cobertura inconclusiva — marque o cadastro como completo e informe se cada dívida está no contas-a-pagar" + os R$ lado a lado (serviço vs geração do A1). **Nunca semáforo quando inconclusivo.**
- **% curto prazo** com barra.
- DSCR-EBITDA / dívida-EBITDA: renderiza **só** se `valor !== null` (senão o componente nem aparece — sem tile "falta D&A").
- Caveat fixo: "Direcional, não substitui balanço/contador. Serviço da dívida do cadastro manual."

A geração operacional do A1 vem do hook do cashflow existente (mesma fonte da projeção 13 semanas); passar `geracaoOperacionalA1` para `dscrCaixa`.

- [ ] **Step 3: Rota lazy em App.tsx**

Adicionar rota `/financeiro/endividamento` (lazy import), no bloco das rotas financeiras master-only.

- [ ] **Step 4: Typecheck + lint + commit**

```bash
heavy bun run typecheck && bun lint
git add src/pages/FinanceiroEndividamento.tsx src/components/financeiro/endividamento/IndicadoresEndividamento.tsx src/App.tsx
git commit -m "feat(financeiro): página de endividamento + indicadores + faixa DSCR (F1)"
```

---

## Task 10: Codex adversarial + health + PR + handoff de deploy

- [ ] **Step 1: Health check completo**

Run: `heavy bun run test && heavy bun run typecheck && bun lint`
Expected: tudo verde. Anexar saída ao PR.

- [ ] **Step 2: Codex adversarial no diff**

`/codex challenge` no diff completo (foco money-path: o DSCR não pode publicar número enganoso; add-back correto; RLS não vaza). Acatar P1, registrar veredito no PR.

- [ ] **Step 3: Abrir PR (draft até deploy)**

Corpo do PR: link da spec, resumo das 3 camadas de deploy manual Lovable (frontend Publish · migration no SQL Editor · sem edge nova), a query de validação pós-apply (Task 5 Step 2), e a nota "⚠️ migration manual".

- [ ] **Step 4: Handoff de deploy (skill lovable-deploy-verify)**

Montar o checklist: (1) migration `20260704160000` colada no SQL Editor + validação; (2) Publish do frontend; (3) sem edge nova. Verificar frontend pelos bytes do bundle após o founder publicar.

---

## Self-Review (feito na escrita)

- **Cobertura da spec:** serviço da dívida (T1) ✓ · DSCR-caixa + gate + add-back (T2) ✓ · saldo/% curto prazo (T3) ✓ · EBITDA degradado (T4) ✓ · 3 tabelas + RLS + triggers (T5) ✓ · prova PG17 + RLS + falsificação (T6) ✓ · overlay/UI inconclusivo (T9) ✓ · antecipação fora do DSCR (T1, excluída em `servicoDivida`) ✓.
- **Placeholders:** helpers/testes/migration com código completo; UI (T8/T9) descreve componentes com os pontos-chave concretos (campo CP, faixa condicional, render-só-se-EBITDA) — sem TODO.
- **Consistência de tipos:** `servicoDivida`, `dscrCaixa`, `saldoDevedorEmAberto`, `pctCurtoPrazo`, `dscrEbitda`, `dividaLiquidaEbitda` com assinaturas idênticas entre tasks e implementação. `DscrResult`/`IndicadorEbitda` definidos em T1.
- **Overlay de caixa ajustado (dívidas 'nao'):** a spec §3 prevê descontar do saldo mostrado; na v1 o índice DSCR já trata 'nao' (sem add-back). O ajuste do saldo projetado exibido é refinamento de UI da T9 (não bloqueia o índice) — se crescer, vira task própria.
