# Otimizador Tributário — Comparador de Regime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comparador de regime tributário (Simples × Presumido × Real) por CNPJ + consolidado do grupo, com degradação honesta, reusando a engine de DRE v2.

**Architecture:** Helper puro `src/lib/financeiro/regime-tributario-helpers.ts` (TDD, vitest) espelhado VERBATIM no edge function Deno `supabase/functions/fin-regime-tributario/index.ts` (master-only). Tabela master-only `fin_regime_inputs` para inputs manuais. Frontend: hook + página `/financeiro/regime-tributario` (master-only) + dialog. Padrão idêntico ao A2 (`fin-valor-engine` / `useValor` / `FinanceiroValor` / `fin_valor_inputs`).

**Tech Stack:** TypeScript, vitest, Deno (edge function), Supabase (Postgres + RLS), React + @tanstack/react-query + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-05-24-financeiro-regime-tributario-design.md` (Codex-cleared, 2 passes). Ler antes de cada task.

---

## Contrato de tipos (compartilhado entre Tasks 4, 7, 8 — type consistency)

Definido em `src/services/financeiroService.ts` (Task 7-pré, mas referenciado aqui):

```typescript
export type RegimeNome = 'simples' | 'presumido' | 'real';
export type StatusElegibilidade = 'elegivel' | 'sublimite_excedido' | 'inelegivel';
export type StatusRecomendacao = 'recomenda' | 'empate_tecnico' | 'manter' | 'incompleto';

export interface RegimeInputs {
  folha_cpp_anual: number | null;            // base do encargo patronal (Presumido/Real)
  massa_fator_r_anual: number | null;        // salários+pró-labore+CPP+FGTS (fator-r Simples)
  encargo_patronal_pct: number | null;       // default 0.20 (CPP estrita); cheia ~0.268
  presuncao_irpj: number | null;             // override (default por atividade)
  presuncao_csll: number | null;
  credito_pis_cofins_estimado: number | null;// % de insumos creditáveis (Real)
  receita_tributavel_pis_cofins_pct: number | null; // 1 − monofásico/ST/alíquota-zero
  anexo_simples: 'I' | 'II' | 'III' | 'IV' | 'V' | null;
}

export interface RegimeComparado {
  regime: RegimeNome;
  elegivel: boolean;
  status_elegibilidade: StatusElegibilidade;
  motivo_inelegivel: string | null;
  total_federal_cpp: number;        // o que entra no ranking
  aliquota_efetiva: number | null;  // total_federal_cpp / receita
  detalhe: Record<string, number>;  // breakdown por tributo
  aproximado: boolean;
  flags: string[];                  // degradação por regime
}

export interface RegimeEmpresaResult {
  empresa: string;
  regime_atual: RegimeNome;
  ttm: { ano_mes_fim: string; meses: number };
  comparados: RegimeComparado[];    // ordenado asc por total_federal_cpp (só elegíveis no ranking)
  recomendado: RegimeNome | null;
  economia_anual: number | null;    // imposto(atual) − imposto(recomendado), ≥ 0
  status: StatusRecomendacao;
  break_even: { margem_real_vs_presumido: number | null; fator_r: number };
  eixo_indireto: { icms_iss_ipi_simples: number | null; observacao: string };
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  regime_inputs: RegimeInputs;      // eco p/ pré-preencher o dialog
}

export interface RegimeTributarioResult {
  por_empresa: RegimeEmpresaResult[];
  consolidado: { imposto_atual_total: number; imposto_otimizado_total: number; economia_total: number; confianca: 'alta' | 'media' | 'baixa' };
  gerado_em: string;
}
```

> ⚠️ Regra geral de paridade: o helper TS (`@/`, aspas simples, tipos importados de `dre-helpers`) e
> o engine Deno (sem `@/`, aspas duplas, tipos inlinados) têm a **mesma lógica verbatim**. Zero `no-explicit-any`.

---

## Task 1: Migration `fin_regime_inputs` (master-only)

**Files:**
- Create: `supabase/migrations/20260524120000_fin_regime_inputs.sql`

- [ ] **Step 1: Escrever a migration** (espelha `supabase/migrations/20260523230000_fin_a2_valor_inputs.sql`)

```sql
-- supabase/migrations/20260524120000_fin_regime_inputs.sql
-- Otimizador Tributário: inputs manuais por empresa em TABELA master-only.
-- Dado sensível (folha, créditos, presunções). O engine fin-regime-tributario usa
-- service_role (bypassa RLS); o app só lê/escreve como master. Idempotente.

CREATE TABLE IF NOT EXISTS fin_regime_inputs (
  company        text PRIMARY KEY,
  regime_inputs  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

COMMENT ON COLUMN fin_regime_inputs.regime_inputs IS
  'Regime: { folha_cpp_anual, massa_fator_r_anual, encargo_patronal_pct, presuncao_irpj, presuncao_csll, credito_pis_cofins_estimado, receita_tributavel_pis_cofins_pct, anexo_simples }';

ALTER TABLE fin_regime_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_regime_inputs_select_master ON fin_regime_inputs;
CREATE POLICY fin_regime_inputs_select_master ON fin_regime_inputs
  FOR SELECT USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_regime_inputs_write_master ON fin_regime_inputs;
CREATE POLICY fin_regime_inputs_write_master ON fin_regime_inputs
  FOR ALL USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

INSERT INTO fin_regime_inputs (company) VALUES ('colacor'), ('oben'), ('colacor_sc')
  ON CONFLICT (company) DO NOTHING;

SELECT 'fin_regime_inputs OK' AS status,
  (SELECT count(*) FROM fin_regime_inputs) AS linhas,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'fin_regime_inputs') AS policies;
```

- [ ] **Step 2: Commit** (NÃO aplicar — entrega manual via Lovable SQL Editor no fim, Task 8)

```bash
git add supabase/migrations/20260524120000_fin_regime_inputs.sql
git commit -m "feat(financeiro regime): migration fin_regime_inputs (master-only)"
```

---

## Task 2: Helper — Simples (partilha + decomposição federal+CPP + elegibilidade)

**Files:**
- Create: `src/lib/financeiro/regime-tributario-helpers.ts`
- Test: `src/lib/financeiro/__tests__/regime-tributario-helpers.test.ts`

Reusa de `./dre-helpers`: `aliquotaEfetivaSimples`, `faixaPorRBT12`, `calcularRBT12`, `anexoPorFatorR`, tipo `AnexoSimples`. Reusa de `./dre-tabelas-tributarias`: `ANEXOS_SIMPLES`, `FATOR_R_LIMIAR`, `PRESUMIDO`.

- [ ] **Step 1: Escrever os testes da partilha + Simples (falhando)**

```typescript
import { describe, it, expect } from 'vitest';
import { PARTILHA_SIMPLES, partilhaIndiretoFrac, impostoAnualSimples, elegibilidadeSimples } from '../regime-tributario-helpers';

describe('PARTILHA_SIMPLES — invariante de soma', () => {
  // Cada faixa de cada anexo deve somar 100% (1.0). Se falhar, a transcrição da LC 123 está errada
  // — corrija contra a fonte oficial, NÃO ajuste o teste.
  it('todas as faixas somam 1.0 (±1e-9)', () => {
    for (const anexo of Object.keys(PARTILHA_SIMPLES) as Array<keyof typeof PARTILHA_SIMPLES>) {
      for (const faixa of PARTILHA_SIMPLES[anexo]) {
        const soma = faixa.irpj + faixa.csll + faixa.cofins + faixa.pis + faixa.cpp + faixa.icms + faixa.iss + faixa.ipi;
        expect(soma).toBeCloseTo(1, 9);
      }
    }
  });
});

describe('partilhaIndiretoFrac — fração indireta (ICMS/ISS/IPI) da alíquota efetiva, com teto de ISS', () => {
  it('anexo I (comércio), 1ª faixa: indireto = ICMS', () => {
    // efetiva baixa, ISS não satura. indireto = efetiva × %ICMS_faixa
    const r = partilhaIndiretoFrac('I', 100000, 0.04); // RBT12 100k → 1ª faixa, efetiva 4%
    expect(r).toBeCloseTo(0.04 * PARTILHA_SIMPLES.I[0].icms, 9);
  });
  it('anexo III, 5ª faixa: ISS satura em 5% e excedente vai pro federal', () => {
    // efetiva > 14,92537% → parcela ISS (efetiva×%ISS) > 5% → capada em 5%.
    const efetiva = 0.18; // > 0.1492537
    const indireto = partilhaIndiretoFrac('III', 2_000_000, efetiva); // 5ª faixa
    // ISS sem teto seria efetiva×0.335 ≈ 0.0603 > 0.05 → cap em 0.05
    expect(indireto).toBeCloseTo(0.05, 9);
  });
});

describe('impostoAnualSimples', () => {
  it('decompõe DAS em federal+CPP (tira ICMS/ISS/IPI)', () => {
    const r = impostoAnualSimples({ anexo: 'I', rbt12: 100000, receitaAnual: 100000 });
    expect(r.das_total).toBeCloseTo(4000, 0);               // 4% × 100k
    expect(r.icms_iss_ipi).toBeCloseTo(4000 * PARTILHA_SIMPLES.I[0].icms, 0);
    expect(r.total_federal_cpp).toBeCloseTo(r.das_total - r.icms_iss_ipi, 0);
    expect(r.aproximado).toBe(true);
  });
});

describe('elegibilidadeSimples — usa RBA (ano-calendário), não RBT12', () => {
  it('RBA ≤ 3,6M → elegivel', () => {
    expect(elegibilidadeSimples(3_000_000).status_elegibilidade).toBe('elegivel');
  });
  it('3,6M < RBA ≤ 4,8M → sublimite_excedido (ICMS/ISS fora do DAS)', () => {
    expect(elegibilidadeSimples(4_000_000).status_elegibilidade).toBe('sublimite_excedido');
  });
  it('RBA > 4,8M → inelegivel', () => {
    const r = elegibilidadeSimples(5_000_000);
    expect(r.status_elegibilidade).toBe('inelegivel');
    expect(r.motivo_inelegivel).toContain('4,8');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- regime-tributario-helpers`
Expected: FAIL ("PARTILHA_SIMPLES is not exported" / "partilhaIndiretoFrac is not a function").

- [ ] **Step 3: Implementar (partilha + decomposição + elegibilidade)**

```typescript
// src/lib/financeiro/regime-tributario-helpers.ts
// Otimizador Tributário — comparador de regime (Simples × Presumido × Real). Módulo puro,
// espelhado VERBATIM no engine Deno supabase/functions/fin-regime-tributario/index.ts.
import { ANEXOS_SIMPLES, type AnexoSimples, FATOR_R_LIMIAR, PRESUMIDO } from './dre-tabelas-tributarias';
import { aliquotaEfetivaSimples } from './dre-helpers';

// Repartição (partilha) da LC 123/2006 c/ LC 155/2016 — fração de cada faixa alocada a cada tributo.
// ⚠️ TRANSCREVER VERBATIM dos Anexos I, II, III, V da LC 123 (fontes no spec). O teste de soma=1
// por faixa é a GUARDA: se não passar, a transcrição está errada — corrija a fonte, não o teste.
export type PartilhaFaixa = { irpj: number; csll: number; cofins: number; pis: number; cpp: number; icms: number; iss: number; ipi: number };
export const PARTILHA_SIMPLES: Record<'I' | 'II' | 'III' | 'V', PartilhaFaixa[]> = {
  // Anexo I — Comércio (ICMS; sem ISS/IPI). 6 faixas.
  I: [
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.415, icms: 0.34, iss: 0, ipi: 0 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.415, icms: 0.34, iss: 0, ipi: 0 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.42,  icms: 0.335, iss: 0, ipi: 0 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.42,  icms: 0.335, iss: 0, ipi: 0 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.42,  icms: 0.335, iss: 0, ipi: 0 },
    { irpj: 0.135, csll: 0.10,  cofins: 0.2827, pis: 0.0613, cpp: 0.421, icms: 0,     iss: 0, ipi: 0 }, // 6ª: sem ICMS
  ],
  // Anexo II — Indústria (ICMS + IPI; sem ISS). 6 faixas.
  II: [
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.085, csll: 0.075, cofins: 0.2096, pis: 0.0454, cpp: 0.235, icms: 0,    iss: 0, ipi: 0.35 }, // 6ª
  ],
  // Anexo III — Serviços (ISS; teto de ISS em 5%). 6 faixas.
  III: [
    { irpj: 0.04, csll: 0.035, cofins: 0.1282, pis: 0.0278, cpp: 0.434, icms: 0, iss: 0.335, ipi: 0 },
    { irpj: 0.04, csll: 0.035, cofins: 0.1405, pis: 0.0305, cpp: 0.434, icms: 0, iss: 0.32,  ipi: 0 },
    { irpj: 0.04, csll: 0.035, cofins: 0.1364, pis: 0.0296, cpp: 0.434, icms: 0, iss: 0.325, ipi: 0 },
    { irpj: 0.04, csll: 0.035, cofins: 0.1364, pis: 0.0296, cpp: 0.434, icms: 0, iss: 0.325, ipi: 0 },
    { irpj: 0.04, csll: 0.035, cofins: 0.1282, pis: 0.0278, cpp: 0.434, icms: 0, iss: 0.335, ipi: 0 }, // teto ISS aqui
    { irpj: 0.35, csll: 0.15,  cofins: 0.1603, pis: 0.0347, cpp: 0.305, icms: 0, iss: 0,     ipi: 0 }, // 6ª: sem ISS
  ],
  // Anexo V — Serviços fator-r < 28% (ISS). 6 faixas.
  V: [
    { irpj: 0.25, csll: 0.15,  cofins: 0.141,  pis: 0.0305, cpp: 0.2885, icms: 0, iss: 0.14,  ipi: 0 },
    { irpj: 0.23, csll: 0.15,  cofins: 0.141,  pis: 0.0305, cpp: 0.2785, icms: 0, iss: 0.17,  ipi: 0 },
    { irpj: 0.24, csll: 0.15,  cofins: 0.1492, pis: 0.0323, cpp: 0.2385, icms: 0, iss: 0.19,  ipi: 0 },
    { irpj: 0.21, csll: 0.15,  cofins: 0.1574, pis: 0.0341, cpp: 0.2385, icms: 0, iss: 0.21,  ipi: 0 },
    { irpj: 0.23, csll: 0.125, cofins: 0.141,  pis: 0.0305, cpp: 0.2385, icms: 0, iss: 0.235, ipi: 0 },
    { irpj: 0.35, csll: 0.155, cofins: 0.1644, pis: 0.0356, cpp: 0.295,  icms: 0, iss: 0,     ipi: 0 }, // 6ª
  ],
};

const TETO_ISS = 0.05; // ISS efetivo (% da receita) não pode passar de 5% (LC 123) — excedente vai pro federal.
const SUBLIMITE_RBA = 3_600_000;
const TETO_RBA = 4_800_000;

function indiceFaixa(anexo: AnexoSimples, rbt12: number): number {
  const faixas = ANEXOS_SIMPLES[anexo];
  for (let i = 0; i < faixas.length; i++) { if (rbt12 <= faixas[i].ate) return i; }
  return faixas.length - 1;
}

// Fração da alíquota efetiva que é indireta (ICMS+ISS+IPI), já com TETO de ISS aplicado.
export function partilhaIndiretoFrac(anexo: 'I' | 'II' | 'III' | 'V', rbt12: number, efetiva: number): number {
  const p = PARTILHA_SIMPLES[anexo][indiceFaixa(anexo as AnexoSimples, rbt12)];
  let iss_frac = efetiva * p.iss;
  if (iss_frac > TETO_ISS) iss_frac = TETO_ISS; // excedente é redistribuído pros federais (some do indireto)
  return efetiva * (p.icms + p.ipi) + iss_frac;
}

export type ImpostoSimples = { total_federal_cpp: number; das_total: number; icms_iss_ipi: number; aproximado: boolean };
export function impostoAnualSimples(input: { anexo: 'I' | 'II' | 'III' | 'V'; rbt12: number; receitaAnual: number }): ImpostoSimples {
  const efetiva = aliquotaEfetivaSimples(input.anexo as AnexoSimples, input.rbt12);
  const das_total = efetiva * input.receitaAnual;
  const indireto_frac = partilhaIndiretoFrac(input.anexo, input.rbt12, efetiva);
  const icms_iss_ipi = indireto_frac * input.receitaAnual;
  return { total_federal_cpp: das_total - icms_iss_ipi, das_total, icms_iss_ipi, aproximado: true };
}

export type Elegibilidade = { status_elegibilidade: 'elegivel' | 'sublimite_excedido' | 'inelegivel'; motivo_inelegivel: string | null };
export function elegibilidadeSimples(rba: number): Elegibilidade {
  if (rba > TETO_RBA) return { status_elegibilidade: 'inelegivel', motivo_inelegivel: `RBA R$ ${(rba / 1e6).toFixed(2)}M > teto R$ 4,8M do Simples.` };
  if (rba > SUBLIMITE_RBA) return { status_elegibilidade: 'sublimite_excedido', motivo_inelegivel: null };
  return { status_elegibilidade: 'elegivel', motivo_inelegivel: null };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test -- regime-tributario-helpers`
Expected: PASS. ⚠️ Se a invariante soma=1 falhar, corrija a transcrição da partilha contra a LC 123 (Anexos I/II/III/V), NÃO o teste.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/regime-tributario-helpers.ts src/lib/financeiro/__tests__/regime-tributario-helpers.test.ts
git commit -m "feat(financeiro regime): partilha do Simples + decomposição federal+CPP + elegibilidade RBA (TDD)"
```

---

## Task 3: Helper — Presumido + Real + encargo patronal + fator-r + break-even

**Files:**
- Modify: `src/lib/financeiro/regime-tributario-helpers.ts`
- Test: `src/lib/financeiro/__tests__/regime-tributario-helpers.test.ts` (append)

- [ ] **Step 1: Escrever os testes (falhando)**

```typescript
import { impostoAnualPresumido, impostoAnualReal, encargoPatronal, anexoEfetivoFatorR, breakEvenMargemReal } from '../regime-tributario-helpers';

describe('impostoAnualPresumido — anualizado, adicional por trimestre, receitas financeiras integrais', () => {
  it('soma 4 trimestres; adicional de 10% por trimestre (não teto anual)', () => {
    // comércio: presunção IRPJ 8% / CSLL 12%. Receita anual 4M → 1M/trimestre.
    // baseIRPJ trim = 1M×8% = 80k; IRPJ = 80k×15% = 12k; adicional = (80k−60k)×10% = 2k → 14k/trim.
    const r = impostoAnualPresumido({ trimestres: [1e6, 1e6, 1e6, 1e6], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(r.irpj).toBeCloseTo(4 * 14000, 0);
  });
  it('sazonalidade: 1 trimestre alto gera adicional que a média esconde', () => {
    // 4M num trimestre só, 0 nos outros → baseIRPJ 320k → adicional (320k−60k)×10% = 26k num trim só.
    const sazonal = impostoAnualPresumido({ trimestres: [4e6, 0, 0, 0], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    const uniforme = impostoAnualPresumido({ trimestres: [1e6, 1e6, 1e6, 1e6], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(sazonal.irpj).toBeGreaterThan(uniforme.irpj);
  });
  it('receitas financeiras entram integrais na base IRPJ/CSLL (não via presunção)', () => {
    const sem = impostoAnualPresumido({ trimestres: [1e6, 1e6, 1e6, 1e6], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    const com = impostoAnualPresumido({ trimestres: [1e6, 1e6, 1e6, 1e6], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 100000, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(com.irpj + com.csll).toBeGreaterThan(sem.irpj + sem.csll);
  });
});

describe('impostoAnualReal', () => {
  it('lucro ≤ 0 → IRPJ/CSLL = 0', () => {
    const r = impostoAnualReal({ lucroAnual: -50000, lucroTrimestres: [-12500, -12500, -12500, -12500], receitaTributavel: 1e6, receitasFinanceiras: 0, creditoPct: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(r.irpj).toBe(0); expect(r.csll).toBe(0);
  });
  it('PIS/COFINS não-cumulativo 9,25% − crédito; financeiras a 4,65%', () => {
    const r = impostoAnualReal({ lucroAnual: 0, lucroTrimestres: [0, 0, 0, 0], receitaTributavel: 1e6, receitasFinanceiras: 100000, creditoPct: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    // 9,25%×1M + 4,65%×100k = 92500 + 4650
    expect(r.pis_cofins).toBeCloseTo(92500 + 4650, 0);
  });
  it('crédito reduz o PIS/COFINS', () => {
    const sem = impostoAnualReal({ lucroAnual: 0, lucroTrimestres: [0,0,0,0], receitaTributavel: 1e6, receitasFinanceiras: 0, creditoPct: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    const com = impostoAnualReal({ lucroAnual: 0, lucroTrimestres: [0,0,0,0], receitaTributavel: 1e6, receitasFinanceiras: 0, creditoPct: 0.3, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(com.pis_cofins).toBeLessThan(sem.pis_cofins);
  });
});

describe('encargoPatronal', () => {
  it('20% da folha (default CPP estrita)', () => { expect(encargoPatronal(500000, 0.20)).toBe(100000); });
  it('folha null → null', () => { expect(encargoPatronal(null, 0.20)).toBeNull(); });
});

describe('anexoEfetivoFatorR', () => {
  it('massa/receita ≥ 28% → III', () => { expect(anexoEfetivoFatorR(300000, 1e6).anexo).toBe('III'); });
  it('< 28% → V', () => { expect(anexoEfetivoFatorR(100000, 1e6).anexo).toBe('V'); });
  it('massa null → banda (ambos)', () => { expect(anexoEfetivoFatorR(null, 1e6).banda).toBe(true); });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- regime-tributario-helpers`
Expected: FAIL ("impostoAnualPresumido is not a function").

- [ ] **Step 3: Implementar (append no helper)**

```typescript
const IRPJ_ADIC_LIMITE_TRIM = PRESUMIDO.irpj_adicional_limite_trimestral; // 60000
const ADIC = PRESUMIDO.irpj_adicional_aliquota; // 0.10
const IRPJ = PRESUMIDO.irpj_aliquota;           // 0.15
const CSLL = PRESUMIDO.csll_aliquota;           // 0.09
const PIS_COFINS_CUMULATIVO = PRESUMIDO.pis_aliquota + PRESUMIDO.cofins_aliquota; // 0.0365
const PIS_COFINS_NAO_CUMULATIVO = 0.0925;       // 1,65% + 7,6%
const PIS_COFINS_FINANCEIRO = 0.0465;           // 0,65% + 4% (Decreto 8.426/2015) — só no não-cumulativo

export type ImpostoPresumido = { irpj: number; csll: number; pis: number; cofins: number; cpp: number; total_federal_cpp: number };
export function impostoAnualPresumido(input: {
  trimestres: number[]; presuncaoIrpj: number; presuncaoCsll: number;
  receitasFinanceiras: number; folhaCppAnual: number | null; encargoPct: number;
}): ImpostoPresumido {
  let irpj = 0, csll = 0;
  const receitaAno = input.trimestres.reduce((s, t) => s + t, 0);
  const recFinPorTrim = input.receitasFinanceiras / 4; // receita financeira entra integral na base
  for (const recTrim of input.trimestres) {
    const baseIrpj = recTrim * input.presuncaoIrpj + recFinPorTrim;
    irpj += baseIrpj * IRPJ + Math.max(0, baseIrpj - IRPJ_ADIC_LIMITE_TRIM) * ADIC;
    csll += (recTrim * input.presuncaoCsll + recFinPorTrim) * CSLL;
  }
  const pisCofins = receitaAno * PIS_COFINS_CUMULATIVO; // financeiras: alíquota-zero no cumulativo
  const pis = receitaAno * PRESUMIDO.pis_aliquota, cofins = receitaAno * PRESUMIDO.cofins_aliquota;
  const cpp = encargoPatronal(input.folhaCppAnual, input.encargoPct) ?? 0;
  return { irpj, csll, pis, cofins, cpp, total_federal_cpp: irpj + csll + pisCofins + cpp };
}

export type ImpostoReal = { irpj: number; csll: number; pis_cofins: number; cpp: number; total_federal_cpp: number; credito_aplicado: number; lucro_usado: number };
export function impostoAnualReal(input: {
  lucroAnual: number; lucroTrimestres: number[]; receitaTributavel: number; receitasFinanceiras: number;
  creditoPct: number; folhaCppAnual: number | null; encargoPct: number;
}): ImpostoReal {
  let irpj = 0, csll = 0;
  for (const lt of input.lucroTrimestres) {
    if (lt <= 0) continue;
    irpj += lt * IRPJ + Math.max(0, lt - IRPJ_ADIC_LIMITE_TRIM) * ADIC;
    csll += lt * CSLL;
  }
  const credito = input.receitaTributavel * PIS_COFINS_NAO_CUMULATIVO * input.creditoPct;
  const pis_cofins = input.receitaTributavel * PIS_COFINS_NAO_CUMULATIVO - credito + input.receitasFinanceiras * PIS_COFINS_FINANCEIRO;
  const cpp = encargoPatronal(input.folhaCppAnual, input.encargoPct) ?? 0;
  return { irpj, csll, pis_cofins, cpp, total_federal_cpp: irpj + csll + pis_cofins + cpp, credito_aplicado: credito, lucro_usado: input.lucroAnual };
}

export function encargoPatronal(folhaCppAnual: number | null, pct: number): number | null {
  if (folhaCppAnual == null) return null;
  return folhaCppAnual * pct;
}

export function anexoEfetivoFatorR(massaFatorR: number | null, receita: number): { anexo: 'III' | 'V'; fator_r: number | null; banda: boolean } {
  if (massaFatorR == null || receita <= 0) return { anexo: 'V', fator_r: null, banda: true };
  const fr = massaFatorR / receita;
  return { anexo: fr >= FATOR_R_LIMIAR ? 'III' : 'V', fator_r: fr, banda: false };
}

// Margem líquida (lucro/receita) abaixo da qual o IRPJ/CSLL do Real fica menor que o do Presumido.
// Presumido IRPJ+CSLL ≈ receita×(presIrpj×0.15 + presCsll×0.09). Real ≈ lucro×(0.15+0.09)=lucro×0.24
// (ignorando adicional p/ o break-even direcional). Iguala: margem* = (presIrpj×0.15+presCsll×0.09)/0.24.
export function breakEvenMargemReal(input: { presuncaoIrpj: number; presuncaoCsll: number }): number {
  return (input.presuncaoIrpj * IRPJ + input.presuncaoCsll * CSLL) / (IRPJ + CSLL);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test -- regime-tributario-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/regime-tributario-helpers.ts src/lib/financeiro/__tests__/regime-tributario-helpers.test.ts
git commit -m "feat(financeiro regime): presumido anualizado + real triagem + encargo patronal + fator-r (TDD)"
```

---

## Task 4: Helper — comparar, recomendar, confiança, consolidado

**Files:**
- Modify: `src/lib/financeiro/regime-tributario-helpers.ts`
- Test: `src/lib/financeiro/__tests__/regime-tributario-helpers.test.ts` (append)

> Tipos: usar os do **Contrato** (topo do plano): `RegimeNome`, `RegimeComparado`, `RegimeEmpresaResult`.
> No helper TS importam-se de `@/services/financeiroService`? NÃO — para manter o helper puro e
> espelhável, **redeclarar os tipos no próprio helper** (export) e o `financeiroService.ts` re-exporta/duplica.
> (Mesma convenção de `next-best-action-helpers.ts`, que define `AcaoCandidata`/`ProximaAcaoResult` localmente.)

- [ ] **Step 1: Escrever os testes (falhando)**

```typescript
import { compararRegimes, recomendarRegime, scoreConfiancaRegime } from '../regime-tributario-helpers';

describe('compararRegimes — ordena elegíveis asc por total_federal_cpp', () => {
  it('regime inelegível (RBA>4,8M) sai do ranking mas aparece marcado', () => {
    const comp = compararRegimes({
      simples: { total_federal_cpp: 50000, das_total: 60000, icms_iss_ipi: 10000, aproximado: true },
      elegSimples: { status_elegibilidade: 'inelegivel', motivo_inelegivel: 'RBA > 4,8M' },
      presumido: { irpj: 30000, csll: 20000, pis: 0, cofins: 0, cpp: 10000, total_federal_cpp: 60000 },
      real: { irpj: 10000, csll: 5000, pis_cofins: 40000, cpp: 10000, total_federal_cpp: 65000, credito_aplicado: 0, lucro_usado: 0 },
    });
    const elegiveis = comp.filter((c) => c.elegivel);
    expect(elegiveis[0].regime).toBe('presumido'); // simples inelegível, presumido < real
    expect(comp.find((c) => c.regime === 'simples')!.elegivel).toBe(false);
  });
});

describe('recomendarRegime', () => {
  it('recomenda o menor; economia = atual − recomendado ≥ 0', () => {
    const comparados = compararRegimes({
      simples: { total_federal_cpp: 40000, das_total: 50000, icms_iss_ipi: 10000, aproximado: true },
      elegSimples: { status_elegibilidade: 'elegivel', motivo_inelegivel: null },
      presumido: { irpj: 30000, csll: 20000, pis: 0, cofins: 0, cpp: 10000, total_federal_cpp: 60000 },
      real: { irpj: 10000, csll: 5000, pis_cofins: 40000, cpp: 10000, total_federal_cpp: 65000, credito_aplicado: 0, lucro_usado: 0 },
    });
    const r = recomendarRegime(comparados, 'presumido', { bandaErro: 0.05 });
    expect(r.recomendado).toBe('simples');
    expect(r.economia_anual).toBeCloseTo(60000 - 40000, 0);
    expect(r.status).toBe('recomenda');
  });
  it('economia dentro da banda de erro + recomendado=real → empate_tecnico', () => {
    const comparados = compararRegimes({
      simples: { total_federal_cpp: 100000, das_total: 110000, icms_iss_ipi: 10000, aproximado: true },
      elegSimples: { status_elegibilidade: 'elegivel', motivo_inelegivel: null },
      presumido: { irpj: 30000, csll: 20000, pis: 0, cofins: 0, cpp: 10000, total_federal_cpp: 61000 },
      real: { irpj: 10000, csll: 5000, pis_cofins: 35000, cpp: 10000, total_federal_cpp: 60000, credito_aplicado: 0, lucro_usado: 100000 },
    });
    // real (60k) ganha do presumido (61k) por só 1k → dentro de 5% → empate técnico
    const r = recomendarRegime(comparados, 'presumido', { bandaErro: 0.05 });
    expect(r.status).toBe('empate_tecnico');
  });
});

describe('scoreConfiancaRegime', () => {
  it('Real sempre ≤ media (LALUR não modelado)', () => {
    const c = scoreConfiancaRegime({ recomendado: 'real', folhaConhecida: true, semFlagsFortes: true });
    expect(c.nivel === 'alta').toBe(false);
  });
  it('sem folha → rebaixa + motivo', () => {
    const c = scoreConfiancaRegime({ recomendado: 'presumido', folhaConhecida: false, semFlagsFortes: true });
    expect(c.nivel).not.toBe('alta');
    expect(c.motivos.join(' ')).toMatch(/folha/i);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — Run: `heavy bun run test -- regime-tributario-helpers` → FAIL.

- [ ] **Step 3: Implementar (append)** — definir os tipos do contrato + as 3 funções:

```typescript
export type RegimeNome = 'simples' | 'presumido' | 'real';
export type StatusElegibilidade = 'elegivel' | 'sublimite_excedido' | 'inelegivel';
export type StatusRecomendacao = 'recomenda' | 'empate_tecnico' | 'manter' | 'incompleto';
export type RegimeComparado = {
  regime: RegimeNome; elegivel: boolean; status_elegibilidade: StatusElegibilidade; motivo_inelegivel: string | null;
  total_federal_cpp: number; aliquota_efetiva: number | null; detalhe: Record<string, number>; aproximado: boolean; flags: string[];
};

export function compararRegimes(input: {
  simples: ImpostoSimples; elegSimples: Elegibilidade;
  presumido: ImpostoPresumido; real: ImpostoReal; receitaAnual?: number;
}): RegimeComparado[] {
  const rec = input.receitaAnual && input.receitaAnual > 0 ? input.receitaAnual : null;
  const simplesElegivel = input.elegSimples.status_elegibilidade !== 'inelegivel';
  const lista: RegimeComparado[] = [
    {
      regime: 'simples', elegivel: simplesElegivel, status_elegibilidade: input.elegSimples.status_elegibilidade,
      motivo_inelegivel: input.elegSimples.motivo_inelegivel, total_federal_cpp: input.simples.total_federal_cpp,
      aliquota_efetiva: rec ? input.simples.total_federal_cpp / rec : null,
      detalhe: { das_total: input.simples.das_total, federal_cpp_do_das: input.simples.total_federal_cpp, icms_iss_ipi: input.simples.icms_iss_ipi },
      aproximado: input.simples.aproximado, flags: input.elegSimples.status_elegibilidade === 'sublimite_excedido' ? ['Sublimite excedido — ICMS/ISS fora do DAS.'] : [],
    },
    {
      regime: 'presumido', elegivel: true, status_elegibilidade: 'elegivel', motivo_inelegivel: null,
      total_federal_cpp: input.presumido.total_federal_cpp, aliquota_efetiva: rec ? input.presumido.total_federal_cpp / rec : null,
      detalhe: { irpj: input.presumido.irpj, csll: input.presumido.csll, pis: input.presumido.pis, cofins: input.presumido.cofins, cpp: input.presumido.cpp }, aproximado: false, flags: [],
    },
    {
      regime: 'real', elegivel: true, status_elegibilidade: 'elegivel', motivo_inelegivel: null,
      total_federal_cpp: input.real.total_federal_cpp, aliquota_efetiva: rec ? input.real.total_federal_cpp / rec : null,
      detalhe: { irpj: input.real.irpj, csll: input.real.csll, pis_cofins: input.real.pis_cofins, cpp: input.real.cpp, credito_aplicado: input.real.credito_aplicado },
      aproximado: true, flags: ['Lucro real ≈ resultado contábil (sem LALUR).', input.real.credito_aplicado === 0 ? 'Crédito PIS/COFINS = 0 (faltam NCM/CFOP) — Real pode ser melhor.' : ''].filter(Boolean),
    },
  ];
  // ordena os ELEGÍVEIS asc; inelegíveis vão pro fim
  return lista.sort((a, b) => {
    if (a.elegivel !== b.elegivel) return a.elegivel ? -1 : 1;
    return a.total_federal_cpp - b.total_federal_cpp;
  });
}

export function recomendarRegime(comparados: RegimeComparado[], regimeAtual: RegimeNome, opts: { bandaErro: number }):
  { recomendado: RegimeNome | null; economia_anual: number | null; status: StatusRecomendacao } {
  const elegiveis = comparados.filter((c) => c.elegivel);
  if (elegiveis.length === 0) return { recomendado: null, economia_anual: null, status: 'incompleto' };
  const melhor = elegiveis[0]; // já ordenado asc
  const atual = comparados.find((c) => c.regime === regimeAtual);
  const economia = atual ? atual.total_federal_cpp - melhor.total_federal_cpp : null;
  if (melhor.regime === regimeAtual) return { recomendado: regimeAtual, economia_anual: 0, status: 'manter' };
  // empate técnico: a vantagem do melhor é menor que a banda de erro relativa ao 2º colocado
  const segundo = elegiveis[1];
  const dentroBanda = segundo ? (segundo.total_federal_cpp - melhor.total_federal_cpp) / Math.max(1, segundo.total_federal_cpp) < opts.bandaErro : false;
  const status: StatusRecomendacao = (melhor.regime === 'real' && dentroBanda) ? 'empate_tecnico' : 'recomenda';
  return { recomendado: melhor.regime, economia_anual: economia != null ? Math.max(0, economia) : null, status };
}

export function scoreConfiancaRegime(input: { recomendado: RegimeNome | null; folhaConhecida: boolean; semFlagsFortes: boolean }):
  { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] } {
  const motivos: string[] = [];
  let nivel = 3; // alta
  const baixar = (p: number, m: string) => { if (p < nivel) nivel = p; motivos.push(m); };
  if (input.recomendado === 'real') baixar(2, 'Lucro Real é triagem (sem LALUR/adições/exclusões) — confiança limitada.');
  if (!input.folhaConhecida) baixar(2, 'Folha (CPP) não informada — comparação Simples × outros incompleta.');
  if (!input.semFlagsFortes) baixar(2, 'Há flags de degradação (monofásico/ST/crédito não estimado).');
  return { nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa', motivos };
}
```

- [ ] **Step 4: Rodar e ver passar** — Run: `heavy bun run test -- regime-tributario-helpers` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/regime-tributario-helpers.ts src/lib/financeiro/__tests__/regime-tributario-helpers.test.ts
git commit -m "feat(financeiro regime): comparar/recomendar/confiança + empate técnico (TDD)"
```

---

## Task 5: Edge function `fin-regime-tributario` (espelho verbatim, master-only)

**Files:**
- Create: `supabase/functions/fin-regime-tributario/index.ts`

Espelhar a estrutura de `supabase/functions/fin-valor-engine/index.ts`:
- `authorizeMaster(req)` **idêntico** (service_role como Bearer OU role master via `user_roles`).
- Helpers de regime **inlinados verbatim** do `regime-tributario-helpers.ts` (sem `@/`, aspas duplas).
- Lê por empresa: `fin_dre_snapshots` (TTM: receita_bruta, receita_liquida, resultado_antes_impostos,
  receitas_financeiras, deduções; pegar o snapshot TTM mais recente), histórico de receita mensal p/ RBA
  (12 meses do ano-calendário; aproximar por TTM com flag se não houver), e `fin_regime_inputs.regime_inputs`.
- Defaults por atividade quando o input não tiver: `colacor` (indústria) anexo II / presunção 8%-12%;
  `oben` (comércio) anexo I / 8%-12%; `colacor_sc` (serviços) anexo III / 32%-32%.
- Monta `RegimeEmpresaResult` por empresa (chama `compararRegimes` → `recomendarRegime` →
  `scoreConfiancaRegime`) + `consolidado` (soma imposto atual e otimizado das 3) + `gerado_em`.
- `fetchAll` paginado onde houver risco de truncamento (>1000 linhas) — mesmo helper do A3.

- [ ] **Step 1: Implementar a edge function** (estrutura; lógica de regime = cópia verbatim do helper)

Estrutura mínima (gate + loop por empresa + retorno). Copiar o bloco `authorizeMaster` e os `corsHeaders`/
`jsonResponse`/`unauthorized` de `fin-valor-engine/index.ts`. Inlinar TODAS as funções do helper
(`PARTILHA_SIMPLES`, `partilhaIndiretoFrac`, `impostoAnualSimples`, `elegibilidadeSimples`,
`impostoAnualPresumido`, `impostoAnualReal`, `encargoPatronal`, `anexoEfetivoFatorR`, `breakEvenMargemReal`,
`compararRegimes`, `recomendarRegime`, `scoreConfiancaRegime`) com aspas duplas e tipos inline.

```typescript
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = await authorizeMaster(req);
  if (!auth.ok) return auth.response;
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE);
  const EMPRESAS = ["colacor", "oben", "colacor_sc"];
  const por_empresa = [];
  for (const empresa of EMPRESAS) {
    // 1. DRE TTM (snapshot mais recente)
    // 2. RBA (12m do ano-calendário; fallback TTM + flag)
    // 3. inputs (fin_regime_inputs) + defaults por atividade
    // 4. impostoAnualSimples/Presumido/Real → compararRegimes → recomendarRegime → scoreConfiancaRegime
    // 5. push RegimeEmpresaResult (com regime_inputs ecoado, eixo_indireto, break_even)
  }
  const consolidado = /* soma atual/otimizado das 3 + pior confiança */;
  return jsonResponse({ por_empresa, consolidado, gerado_em: new Date().toISOString() });
});
```

- [ ] **Step 2: `deno check`**

Run: `cd supabase/functions/fin-regime-tributario && deno check index.ts; cd -`
Expected: sem erros de tipo. (Se `deno` não estiver no PATH, validar manualmente que não há `@/`, que as
aspas são duplas e que os tipos batem com o helper.)

- [ ] **Step 3: Paridade helper × engine** — conferir lado a lado que a matemática (partilha, teto de ISS,
  adicional por trimestre, PIS/COFINS financeiro do Real) é **idêntica** ao `regime-tributario-helpers.ts`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/fin-regime-tributario/index.ts
git commit -m "feat(financeiro regime): edge function fin-regime-tributario (master-only, espelha helper)"
```

---

## Task 6: Tipos no service + hook + dialog

**Files:**
- Modify: `src/services/financeiroService.ts` (append os tipos do **Contrato** — `RegimeInputs`, `RegimeComparado`, `RegimeEmpresaResult`, `RegimeTributarioResult`, `RegimeNome`, `StatusElegibilidade`, `StatusRecomendacao`)
- Create: `src/hooks/useRegimeTributario.ts`
- Create: `src/components/financeiro/RegimeInputsDialog.tsx`

- [ ] **Step 1: Append os tipos do Contrato** em `financeiroService.ts` (bloco `// ═══ Otimizador Tributário ═══`).

- [ ] **Step 2: Hook** (espelha `src/hooks/useValor.ts` — query do engine + mutation de upsert dos inputs)

```typescript
// src/hooks/useRegimeTributario.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import type { RegimeTributarioResult, RegimeInputs } from '@/services/financeiroService';

export function useRegimeTributario() {
  return useQuery({
    queryKey: ['fin_regime_tributario'],
    queryFn: async (): Promise<RegimeTributarioResult> => {
      const { data, error } = await supabase.functions.invoke('fin-regime-tributario', { body: {} });
      if (error) throw error;
      return data as RegimeTributarioResult;
    },
  });
}

export function useUpdateRegimeInputs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ company, regime_inputs }: { company: string; regime_inputs: RegimeInputs }) => {
      const { error } = await supabase.from('fin_regime_inputs').upsert(
        { company, regime_inputs: regime_inputs as unknown as Json, updated_at: new Date().toISOString() },
        { onConflict: 'company' },
      );
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fin_regime_tributario'] }); },
  });
}
```

- [ ] **Step 3: Dialog** (espelha `src/components/financeiro/ValorInputsDialog.tsx`) — campos: folha_cpp_anual,
  massa_fator_r_anual, encargo_patronal_pct, presuncao_irpj, presuncao_csll, credito_pis_cofins_estimado,
  receita_tributavel_pis_cofins_pct, anexo_simples. Pré-preenche com `atual: RegimeInputs`, chama `useUpdateRegimeInputs`.

- [ ] **Step 4: Typecheck + commit**

```bash
heavy bun run typecheck:strict 2>/dev/null || bunx tsc --noEmit
git add src/services/financeiroService.ts src/hooks/useRegimeTributario.ts src/components/financeiro/RegimeInputsDialog.tsx
git commit -m "feat(financeiro regime): tipos do contrato + hook + dialog de inputs"
```

---

## Task 7: Página + rota + sidebar (master-only)

**Files:**
- Create: `src/pages/FinanceiroRegimeTributario.tsx`
- Modify: `src/App.tsx` (lazy import + rota `financeiro/regime-tributario`)
- Modify: `src/components/AppShell.tsx` (NavItem `masterOnly: true` na seção Financeiro)

- [ ] **Step 1: Página** (espelha `src/pages/FinanceiroValor.tsx`): gate `const { isMaster } = useAuth();`
  → se `!isMaster`, card "Acesso restrito". Usa `useRegimeTributario()`. Por empresa: tabela de regimes
  (atual destacado, recomendado com badge), economia anual, status (`recomenda`/`empate_tecnico`/`manter`/
  `incompleto`), confiança + motivos, eixo indireto e break-even. Bloco consolidado do grupo. Caveat fixo:
  *"Recomenda, não declara. Troca de regime exige validação do contador + substância econômica."*
  `<RegimeInputsDialog>` por empresa com `atual={emp.regime_inputs}`. Cores: `text-status-*` (nunca emerald/red-600).

- [ ] **Step 2: Rota em `App.tsx`**

```tsx
const FinanceiroRegimeTributario = lazy(() => import("./pages/FinanceiroRegimeTributario"));
// dentro do <Route> group financeiro:
<Route path="financeiro/regime-tributario" element={<FinanceiroRegimeTributario />} />
```

- [ ] **Step 3: Sidebar em `AppShell.tsx`** — na seção Financeiro, ao lado de "Retorno & Valor":

```tsx
{ icon: Landmark, label: 'Regime Tributário', path: '/financeiro/regime-tributario', masterOnly: true },
```
(usar um ícone do lucide já importado ou adicionar `Landmark`/`Scale` ao import.)

- [ ] **Step 4: Build + commit**

```bash
heavy bun run typecheck:strict 2>/dev/null || bunx tsc --noEmit
git add src/pages/FinanceiroRegimeTributario.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(financeiro regime): página /financeiro/regime-tributario (master-only) + rota + sidebar"
```

---

## Task 8: Docs + validação final + revisão Codex + push/PR

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md` (seção "Otimizador Tributário — Comparador de Regime")
- Regenerar: `bun run audit:migrations` (atualiza `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql`)

- [ ] **Step 1: Doc** — seção em `FINANCEIRO_CONFIABILIDADE.md`: metodologia (federal+CPP via partilha,
  RBA vs RBT12, Real como triagem, receitas financeiras, encargo patronal, eixo indireto), inputs, degradação,
  e o caveat "recomenda, não declara". Listar a migration manual e os 3 entregáveis (SQL + deploy).

- [ ] **Step 2: Suite completa**

Run: `heavy bun run test`
Expected: verde (os ~35 testes novos + os existentes). Flakiness conhecida de componentes sob carga — se
algum teste NÃO-feature falhar em lote, reconfirmar isoladamente; o CI `validate` é a verdade.

Run: `heavy bun lint`
Expected: sem erros novos.

- [ ] **Step 3: Regenerar audit + commit docs**

```bash
bun run audit:migrations
git add docs/FINANCEIRO_CONFIABILIDADE.md docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "docs(financeiro regime): seção CONFIABILIDADE + audit de migrations"
```

- [ ] **Step 4: Revisão adversária com Codex** (igual A2/A3/A4)

```bash
codex exec "Revise a implementação do comparador de regime tributário: src/lib/financeiro/regime-tributario-helpers.ts (helper puro), supabase/functions/fin-regime-tributario/index.ts (espelho), e os testes. Foque em: (1) paridade EXATA helper×engine; (2) corretude da partilha + teto de ISS; (3) adicional de IRPJ por trimestre; (4) PIS/COFINS financeiro no Real (4,65%); (5) degradação honesta (sem número fabricado); (6) gate master-only. Aponte só o que está ERRADO ou arriscado. Conciso, em português." -C $(pwd) -s read-only -c 'model_reasoning_effort="high"' 2>&1 | tail -60
```
Incorporar achados P1/P2; re-rodar testes; commit dos fixes.

- [ ] **Step 5: Push + PR** (quando o founder autorizar)

```bash
git push -u origin feat/financeiro-regime-tributario
gh pr create --title "feat(financeiro): Otimizador Tributário — comparador de regime (Simples×Presumido×Real)" --body "$(cat <<'EOF'
## Resumo
Comparador de regime tributário por CNPJ + consolidado do grupo, reusando a engine de DRE v2.
Base de comparação federal+CPP via partilha do DAS; Real como triagem de baixa confiança;
degradação honesta. Spec Codex-cleared (2 passes).

## ATENÇÃO: migration manual necessária
`supabase/migrations/20260524120000_fin_regime_inputs.sql` — colar no SQL Editor do Lovable (master-only).

## Deploy manual (Lovable chat)
`fin-regime-tributario` (nova edge function, master-only) — deploy verbatim do repo após merge.

## Test plan
- [ ] ~35 testes do helper verdes (partilha soma=1, teto ISS, adicional trimestral, PIS/COFINS financeiro)
- [ ] CI `validate` verde
- [ ] QA master na página /financeiro/regime-tributario
EOF
)"
```

---

## Self-Review (preencher na execução)
- **Cobertura do spec:** §2.1–2.6 → Tasks 2-4; §3.1 helper → Tasks 2-4; §3.2 engine → Task 5; §3.3 tabela → Task 1; §3.4 frontend → Tasks 6-7; §3.5 docs → Task 8. ✅
- **Sem placeholders:** código real em cada step de helper/migration/hook; engine e página referenciam os arquivos-padrão A2 (anchors exatos).
- **Consistência de tipos:** `RegimeComparado`/`RegimeEmpresaResult`/`RegimeTributarioResult`/`RegimeInputs` definidos no Contrato (topo) e reusados em Tasks 4/6; nomes de função idênticos entre Tasks 2-4 e Task 5 (engine).
