# Onda 3b — DRE v2: motor de imposto teórico (Simples + presumido) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Adicionar à DRE (já regime-aware da Onda 3a) o **imposto teórico esperado por regime** como conferência ao lado do realizado: Simples com RBT12 + tabela de anexo + fator-r; presumido trimestral com presunção por atividade + adicional de 10%. Degradação honesta (`null`, nunca número inventado) quando faltar dado.

**Architecture:** Tabelas legais como constantes em `src/lib/financeiro/dre-tabelas-tributarias.ts`; funções puras em `dre-helpers.ts` (vitest), espelhadas verbatim no engine Deno `omie-financeiro`. Config tributária por empresa = coluna JSONB opcional `dre_tributario` em `fin_config_cashflow` (SQL idempotente; sem ela, degrade). UI mostra teórico×realizado + delta.

**Tech Stack:** TypeScript, vitest (`bun run test`), Deno edge function (deploy via chat do Lovable), React.

**Pré-requisito:** Onda 3a mergeada (estrutura regime-aware, `montarDRE`, `detalhamento.impostos`, `confianca`). Esta branch sai da `main` pós-3a.

---

## Contexto

A Onda 3a já entrega o imposto **realizado** (do Omie) quebrado regime-aware no `detalhamento.impostos` (`das` no Simples; `ded_*` + `irpj`/`csll` no presumido). A 3b adiciona o **teórico**: quanto de imposto *deveria* ter saído dado o faturamento, como sanity-check. Codex alertou: alíquota fixa engana — Simples exige fórmula progressiva (RBT12, anexo, fator-r); presumido é trimestral + adicional. Onde faltar dado → `null` + rebaixa confiança.

Empresas: Colacor & Oben (presumido), Colacor SC (Simples, serviços → Anexo III ou V via fator-r).

---

## File Structure

- **Create** `src/lib/financeiro/dre-tabelas-tributarias.ts` — constantes legais (Anexos I–V Simples; presunções presumido). ⚠️ Valores conferidos contra a LC 123/Receita Federal no T1.
- **Modify** `src/lib/financeiro/dre-helpers.ts` — `calcularRBT12`, `aliquotaEfetivaSimples`, `impostoTeoricoSimples`, `impostoTeoricoPresumido`, tipo `ConfigTributario`.
- **Modify** `src/lib/financeiro/__tests__/dre-helpers.test.ts` — testes.
- **Modify** `supabase/functions/omie-financeiro/index.ts` — espelha helpers + calcula teórico em `calcularDRE`, persiste `detalhamento.imposto_teorico` + delta, alimenta confiança.
- **Modify** `src/services/financeiroService.ts` — tipo `detalhamento.imposto_teorico`.
- **Modify** `src/pages/FinanceiroCockpit.tsx` — coluna teórico×realizado + delta.
- **Modify** `docs/FINANCEIRO_CONFIABILIDADE.md` — seção Onda 3b.
- **SQL (opcional)** — `dre_tributario` JSONB em `fin_config_cashflow` (entregue inline pro SQL Editor).

---

## Task 1: Tabelas tributárias (constantes) + RBT12 (TDD)

**Files:**
- Create: `src/lib/financeiro/dre-tabelas-tributarias.ts`
- Modify: `src/lib/financeiro/dre-helpers.ts`, `src/lib/financeiro/__tests__/dre-helpers.test.ts`

> ⚠️ **Conferência obrigatória:** antes de finalizar, valide os valores das faixas (alíquota nominal + parcela a deduzir) dos Anexos I–V contra a tabela vigente da LC 123 (Receita Federal). Os valores abaixo são os vigentes desde 2018 (LC 155/2016) — confirme que não houve atualização.

- [ ] **Step 1: Criar `dre-tabelas-tributarias.ts`**

```ts
// src/lib/financeiro/dre-tabelas-tributarias.ts
// Tabelas legais (LC 123/2006 c/ LC 155/2016, vigentes desde 2018). Conferir contra
// a Receita Federal ao manter. Espelhado verbatim no engine Deno.

export type AnexoSimples = 'I' | 'II' | 'III' | 'IV' | 'V';
export type FaixaSimples = { ate: number; aliquota: number; deduzir: number };

// Faixa por RBT12 (R$). aliquota = nominal (fração); deduzir = parcela a deduzir (R$).
export const ANEXOS_SIMPLES: Record<AnexoSimples, FaixaSimples[]> = {
  I: [ // Comércio
    { ate: 180000, aliquota: 0.04, deduzir: 0 },
    { ate: 360000, aliquota: 0.073, deduzir: 5940 },
    { ate: 720000, aliquota: 0.095, deduzir: 13860 },
    { ate: 1800000, aliquota: 0.107, deduzir: 22500 },
    { ate: 3600000, aliquota: 0.143, deduzir: 87300 },
    { ate: 4800000, aliquota: 0.19, deduzir: 378000 },
  ],
  II: [ // Indústria
    { ate: 180000, aliquota: 0.045, deduzir: 0 },
    { ate: 360000, aliquota: 0.078, deduzir: 5940 },
    { ate: 720000, aliquota: 0.10, deduzir: 13860 },
    { ate: 1800000, aliquota: 0.112, deduzir: 22500 },
    { ate: 3600000, aliquota: 0.147, deduzir: 85500 },
    { ate: 4800000, aliquota: 0.30, deduzir: 720000 },
  ],
  III: [ // Serviços (locação, etc. / fator-r ≥ 28%)
    { ate: 180000, aliquota: 0.06, deduzir: 0 },
    { ate: 360000, aliquota: 0.112, deduzir: 9360 },
    { ate: 720000, aliquota: 0.135, deduzir: 17640 },
    { ate: 1800000, aliquota: 0.16, deduzir: 35640 },
    { ate: 3600000, aliquota: 0.21, deduzir: 125640 },
    { ate: 4800000, aliquota: 0.33, deduzir: 648000 },
  ],
  IV: [ // Serviços (limpeza, construção, advocacia)
    { ate: 180000, aliquota: 0.045, deduzir: 0 },
    { ate: 360000, aliquota: 0.09, deduzir: 8100 },
    { ate: 720000, aliquota: 0.102, deduzir: 12420 },
    { ate: 1800000, aliquota: 0.14, deduzir: 39780 },
    { ate: 3600000, aliquota: 0.22, deduzir: 183780 },
    { ate: 4800000, aliquota: 0.33, deduzir: 828000 },
  ],
  V: [ // Serviços (fator-r < 28%)
    { ate: 180000, aliquota: 0.155, deduzir: 0 },
    { ate: 360000, aliquota: 0.18, deduzir: 4500 },
    { ate: 720000, aliquota: 0.195, deduzir: 9900 },
    { ate: 1800000, aliquota: 0.205, deduzir: 17100 },
    { ate: 3600000, aliquota: 0.23, deduzir: 62100 },
    { ate: 4800000, aliquota: 0.305, deduzir: 540000 },
  ],
};

// Presumido (frações). Presunção da base por atividade no config da empresa.
export const PRESUMIDO = {
  irpj_aliquota: 0.15,
  irpj_adicional_aliquota: 0.10,
  irpj_adicional_limite_trimestral: 60000, // R$ 20k/mês
  csll_aliquota: 0.09,
  pis_aliquota: 0.0065,
  cofins_aliquota: 0.03,
};

export const FATOR_R_LIMIAR = 0.28; // folha12m / receita12m ≥ 28% → Anexo III, senão V
```

- [ ] **Step 2: Test do RBT12 (append em `dre-helpers.test.ts`)**

```ts
import { calcularRBT12 } from '../dre-helpers';

describe('calcularRBT12', () => {
  const hist = [ // {ano, mes, receita_bruta}
    { ano: 2025, mes: 6, receita_bruta: 50000 },
    { ano: 2026, mes: 4, receita_bruta: 30000 },
    { ano: 2026, mes: 5, receita_bruta: 40000 }, // mês de apuração — NÃO conta
    { ano: 2024, mes: 1, receita_bruta: 99999 }, // fora dos 12m anteriores
  ];
  it('soma os 12 meses ANTERIORES ao mês de apuração', () => {
    // apuração maio/2026 → janela jun/2025..abr/2026
    expect(calcularRBT12(hist, 2026, 5)).toBe(80000); // 50000 + 30000
  });
  it('sem histórico → 0', () => {
    expect(calcularRBT12([], 2026, 5)).toBe(0);
  });
});
```

- [ ] **Step 3: Run → FAIL.** `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`

- [ ] **Step 4: Implementar `calcularRBT12` (append em `dre-helpers.ts`)**

```ts
export type ReceitaMensal = { ano: number; mes: number; receita_bruta: number };

// RBT12 = soma da receita bruta dos 12 meses ANTERIORES ao mês de apuração (exclusivo).
export function calcularRBT12(historico: ReceitaMensal[], ano: number, mes: number): number {
  const idxApuracao = ano * 12 + mes;            // índice do mês de apuração
  const idxInicio = idxApuracao - 12;            // 12 meses antes
  return historico.reduce((s, h) => {
    const idx = h.ano * 12 + h.mes;
    return (idx >= idxInicio && idx < idxApuracao) ? s + h.receita_bruta : s;
  }, 0);
}
```

- [ ] **Step 5: Run → PASS.** Commit local:
```
git add src/lib/financeiro/dre-tabelas-tributarias.ts src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts
git commit -m "feat(financeiro onda3b): tabelas tributárias + calcularRBT12 (TDD)"
```

---

## Task 2: `aliquotaEfetivaSimples` + fator-r (TDD)

**Files:** Modify `src/lib/financeiro/dre-helpers.ts`, `__tests__/dre-helpers.test.ts`

- [ ] **Step 1: Test (append)**

```ts
import { faixaPorRBT12, aliquotaEfetivaSimples, anexoPorFatorR } from '../dre-helpers';

describe('faixaPorRBT12 / aliquotaEfetivaSimples (Anexo III)', () => {
  it('RBT12 na 2ª faixa: efetiva = (RBT12*nominal - deduzir)/RBT12', () => {
    // Anexo III, RBT12 = 300.000 → faixa 2 (0.112, deduzir 9360)
    // efetiva = (300000*0.112 - 9360)/300000 = (33600-9360)/300000 = 0.0808
    expect(aliquotaEfetivaSimples('III', 300000)).toBeCloseTo(0.0808, 4);
  });
  it('RBT12 = 0 → 0', () => {
    expect(aliquotaEfetivaSimples('III', 0)).toBe(0);
  });
  it('última faixa por excesso (acima de 4.8M usa a última)', () => {
    expect(aliquotaEfetivaSimples('III', 5000000)).toBeGreaterThan(0);
  });
});

describe('anexoPorFatorR', () => {
  it('fator-r ≥ 28% → III; < 28% → V', () => {
    expect(anexoPorFatorR(0.30)).toBe('III');
    expect(anexoPorFatorR(0.20)).toBe('V');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implementar (append em `dre-helpers.ts`)**

```ts
import { ANEXOS_SIMPLES, type AnexoSimples, type FaixaSimples, FATOR_R_LIMIAR } from './dre-tabelas-tributarias';

export function faixaPorRBT12(anexo: AnexoSimples, rbt12: number): FaixaSimples {
  const faixas = ANEXOS_SIMPLES[anexo];
  for (const f of faixas) {
    if (rbt12 <= f.ate) return f;
  }
  return faixas[faixas.length - 1]; // acima do teto: usa a última
}

// Alíquota efetiva do Simples: (RBT12 × nominal − parcela a deduzir) / RBT12.
export function aliquotaEfetivaSimples(anexo: AnexoSimples, rbt12: number): number {
  if (rbt12 <= 0) return 0;
  const f = faixaPorRBT12(anexo, rbt12);
  const efetiva = (rbt12 * f.aliquota - f.deduzir) / rbt12;
  return Math.max(0, efetiva);
}

export function anexoPorFatorR(fatorR: number): AnexoSimples {
  return fatorR >= FATOR_R_LIMIAR ? 'III' : 'V';
}
```

> Nota Deno: no engine, o `import` de `./dre-tabelas-tributarias` vira o conteúdo inlineado (ver Task 5). No frontend, mantém o import.

- [ ] **Step 4: Run → PASS.** Commit:
```
git add src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts
git commit -m "feat(financeiro onda3b): aliquotaEfetivaSimples + fator-r (TDD)"
```

---

## Task 3: `impostoTeoricoSimples` + `impostoTeoricoPresumido` (TDD)

**Files:** Modify `src/lib/financeiro/dre-helpers.ts`, `__tests__/dre-helpers.test.ts`

> `ConfigTributario` carrega o que vem da config por empresa. Quando o dado essencial falta, a função devolve `null` (degrade honesto).

- [ ] **Step 1: Test (append)**

```ts
import { impostoTeoricoSimples, impostoTeoricoPresumido } from '../dre-helpers';

describe('impostoTeoricoSimples', () => {
  it('DAS teórico = efetiva × receita do mês', () => {
    // Anexo III, RBT12 300k → efetiva 0.0808; receita mês 25k → ~2020
    const r = impostoTeoricoSimples({ anexo: 'III', rbt12: 300000, receitaMes: 25000 });
    expect(r).toBeCloseTo(0.0808 * 25000, 0);
  });
  it('sem anexo → null (degrade)', () => {
    expect(impostoTeoricoSimples({ anexo: null, rbt12: 300000, receitaMes: 25000 })).toBeNull();
  });
});

describe('impostoTeoricoPresumido', () => {
  it('IRPJ+CSLL trimestral + PIS/COFINS; adicional só sobre excedente de 60k', () => {
    // receita trimestre 1.000.000, presunção IRPJ 0.08, CSLL 0.12 (comércio/indústria)
    // base IRPJ = 80.000 → IRPJ 15% = 12.000; adicional 10% sobre (80.000-60.000)=2.000 → total IRPJ 14.000
    // base CSLL = 120.000 → CSLL 9% = 10.800
    // PIS 0.65% + COFINS 3% sobre 1.000.000 = 6.500 + 30.000 = 36.500
    const r = impostoTeoricoPresumido({ receitaTrimestre: 1000000, presuncaoIrpj: 0.08, presuncaoCsll: 0.12 });
    expect(r.irpj).toBeCloseTo(14000, 0);
    expect(r.csll).toBeCloseTo(10800, 0);
    expect(r.pis).toBeCloseTo(6500, 0);
    expect(r.cofins).toBeCloseTo(30000, 0);
  });
  it('sem excedente → sem adicional', () => {
    const r = impostoTeoricoPresumido({ receitaTrimestre: 100000, presuncaoIrpj: 0.08, presuncaoCsll: 0.12 });
    // base IRPJ = 8.000 < 60.000 → adicional 0; IRPJ = 1.200
    expect(r.irpj).toBeCloseTo(1200, 0);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implementar (append em `dre-helpers.ts`)**

```ts
import { PRESUMIDO } from './dre-tabelas-tributarias';

export function impostoTeoricoSimples(input: {
  anexo: AnexoSimples | null;
  rbt12: number;
  receitaMes: number;
}): number | null {
  if (!input.anexo) return null;            // degrade: sem anexo configurado
  const efetiva = aliquotaEfetivaSimples(input.anexo, input.rbt12);
  return efetiva * input.receitaMes;
}

export function impostoTeoricoPresumido(input: {
  receitaTrimestre: number;
  presuncaoIrpj: number;
  presuncaoCsll: number;
}): { irpj: number; csll: number; pis: number; cofins: number; total: number } {
  const baseIrpj = input.receitaTrimestre * input.presuncaoIrpj;
  const irpjBase = baseIrpj * PRESUMIDO.irpj_aliquota;
  const adicional = Math.max(0, baseIrpj - PRESUMIDO.irpj_adicional_limite_trimestral) * PRESUMIDO.irpj_adicional_aliquota;
  const irpj = irpjBase + adicional;
  const csll = input.receitaTrimestre * input.presuncaoCsll * PRESUMIDO.csll_aliquota;
  const pis = input.receitaTrimestre * PRESUMIDO.pis_aliquota;
  const cofins = input.receitaTrimestre * PRESUMIDO.cofins_aliquota;
  return { irpj, csll, pis, cofins, total: irpj + csll + pis + cofins };
}
```

- [ ] **Step 4: Run → PASS.** Commit:
```
git add src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts
git commit -m "feat(financeiro onda3b): imposto teórico Simples + presumido (TDD)"
```

---

## Task 4: Tipo `ConfigTributario` + leitura de config (TDD)

**Files:** Modify `src/lib/financeiro/dre-helpers.ts`, `__tests__/dre-helpers.test.ts`

> O engine lê `fin_config_cashflow.dre_tributario` (JSONB). Aqui só o tipo + um normalizador puro que aplica defaults por empresa (degrade quando config ausente).

- [ ] **Step 1: Test (append)**

```ts
import { normalizarConfigTributario } from '../dre-helpers';

describe('normalizarConfigTributario', () => {
  it('config ausente → default por empresa (Colacor SC = simples, sem anexo → teórico degrada)', () => {
    const c = normalizarConfigTributario('colacor_sc', null);
    expect(c.regime).toBe('simples');
    expect(c.anexo).toBeNull();           // sem anexo configurado → teórico null
    expect(c.completa).toBe(false);
  });
  it('config presente: presumido com presunções', () => {
    const c = normalizarConfigTributario('colacor', { regime: 'presumido', presuncao_irpj: 0.08, presuncao_csll: 0.12 });
    expect(c.regime).toBe('presumido');
    expect(c.presuncaoIrpj).toBe(0.08);
    expect(c.completa).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implementar (append em `dre-helpers.ts`)**

```ts
export type ConfigTributario = {
  regime: RegimeTributario;
  anexo: AnexoSimples | null;       // Simples
  fatorRHabilitado: boolean;        // Simples: alterna III/V por fator-r
  presuncaoIrpj: number;            // presumido
  presuncaoCsll: number;            // presumido
  completa: boolean;                // false → teórico parcial, confiança ≤ media
};

const PRESUNCAO_DEFAULT = { irpj: 0.08, csll: 0.12 }; // comércio/indústria

export function normalizarConfigTributario(
  company: string,
  raw: Record<string, unknown> | null,
): ConfigTributario {
  const regimeDefault = REGIME_POR_EMPRESA[company] ?? 'presumido';
  const regime = ((raw?.regime as RegimeTributario) ?? regimeDefault);
  const anexo = (raw?.anexo as AnexoSimples | undefined) ?? null;
  const presuncaoIrpj = Number(raw?.presuncao_irpj ?? PRESUNCAO_DEFAULT.irpj);
  const presuncaoCsll = Number(raw?.presuncao_csll ?? PRESUNCAO_DEFAULT.csll);
  const fatorRHabilitado = Boolean(raw?.fator_r_habilitado ?? false);
  // "completa": presumido tem default sensato (presunção); Simples PRECISA de anexo.
  const completa = regime === 'presumido' ? raw != null : anexo != null;
  return { regime, anexo, fatorRHabilitado, presuncaoIrpj, presuncaoCsll, completa };
}
```

- [ ] **Step 4: Run → PASS.** Commit:
```
git add src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts
git commit -m "feat(financeiro onda3b): ConfigTributario + normalizar (TDD)"
```

---

## Task 5: Espelhar no engine + calcular teórico em `calcularDRE`

**Files:** Modify `supabase/functions/omie-financeiro/index.ts`

- [ ] **Step 1: Espelhar constantes + funções**

No bloco "Onda 3a — DRE v2 estrutural" do engine, **adicionar** (inlineado, sem `import`): `ANEXOS_SIMPLES`, `PRESUMIDO`, `FATOR_R_LIMIAR`, tipos `AnexoSimples`/`FaixaSimples`/`ReceitaMensal`/`ConfigTributario`, e as funções `calcularRBT12`, `faixaPorRBT12`, `aliquotaEfetivaSimples`, `anexoPorFatorR`, `impostoTeoricoSimples`, `impostoTeoricoPresumido`, `normalizarConfigTributario`, `PRESUNCAO_DEFAULT` — copiadas verbatim de `dre-helpers.ts`/`dre-tabelas-tributarias.ts` (remover os `import` entre eles, pois tudo fica no mesmo arquivo).

- [ ] **Step 2: Carregar config + histórico de receita em `calcularDRE`**

Após carregar `mapping`, adicionar:
```ts
// Config tributária (coluna opcional — degrade se ausente)
const cfgRes = await db.from("fin_config_cashflow").select("dre_tributario").eq("company", company).maybeSingle();
const configTrib = normalizarConfigTributario(company, (cfgRes.data as { dre_tributario?: Record<string, unknown> } | null)?.dre_tributario ?? null);

// Histórico de receita bruta (competência) p/ RBT12 (Simples) ou receita trimestral (presumido)
const histRes = await db.from("fin_dre_snapshots").select("ano, mes, receita_bruta").eq("company", company).eq("regime", "competencia");
const histReceita = ((histRes.data ?? []) as Array<{ ano: number; mes: number; receita_bruta: number }>);
```

- [ ] **Step 3: Calcular teórico (após `const dre = montarDRE(...)`)**

```ts
// ── Imposto teórico (conferência) — degrade honesto p/ null quando faltar dado ──
let imposto_teorico: Record<string, number | null> | null = null;
let delta_imposto_pct: number | null = null;
if (regimeTrib === "simples") {
  const rbt12 = calcularRBT12(histReceita, ano, mes);
  let anexo = configTrib.anexo;
  if (anexo && configTrib.fatorRHabilitado) {
    // fator-r aproximado: folha 12m / receita 12m (folha = despesas_administrativas é proxy fraco;
    // sem dado de folha segregada, mantém o anexo configurado — degrade)
    anexo = configTrib.anexo; // sem folha confiável, não alterna (documentado)
  }
  const dasTeorico = impostoTeoricoSimples({ anexo, rbt12, receitaMes: dre.receita_bruta });
  imposto_teorico = { das: dasTeorico };
  if (dasTeorico != null && (dre.detalhamento_impostos.das ?? 0) > 0) {
    delta_imposto_pct = (dre.detalhamento_impostos.das - dasTeorico) / dasTeorico;
  }
} else {
  // presumido: teórico trimestral rateado pro mês (receita do trimestre ≈ 3× receita mês como proxy
  // simples NÃO; usa receita do mês × 3 só quando não há série; preferir somar os 3 meses do trimestre)
  const triIdx = Math.floor((mes - 1) / 3); // 0..3
  const mesesTri = [triIdx * 3 + 1, triIdx * 3 + 2, triIdx * 3 + 3];
  const receitaTri = histReceita.filter(h => h.ano === ano && mesesTri.includes(h.mes)).reduce((s, h) => s + h.receita_bruta, 0) || dre.receita_bruta;
  const teo = impostoTeoricoPresumido({ receitaTrimestre: receitaTri, presuncaoIrpj: configTrib.presuncaoIrpj, presuncaoCsll: configTrib.presuncaoCsll });
  // teórico mensal aproximado = trimestre / 3 (rateio linear, documentado como aproximação)
  imposto_teorico = { irpj: teo.irpj / 3, csll: teo.csll / 3, pis: teo.pis / 3, cofins: teo.cofins / 3, total: teo.total / 3 };
}
```

- [ ] **Step 4: Persistir + alimentar confiança**

No `detalhamento`, adicionar `imposto_teorico`, `delta_imposto_pct`, `config_tributaria_completa: configTrib.completa`. Recalcular `scoreConfianca` incluindo o sinal de delta e config incompleta — substituir a chamada existente por:
```ts
const confianca = scoreConfianca({
  pct_mapeado_valor: valorTotal > 0 ? valorMapeado / valorTotal : 1,
  fallback_pct,
  share_generico: valorTotal > 0 ? valorGenerico / valorTotal : 0,
  tem_imposto_nao_mapeado: temImpostoNaoMapeado,
});
// Onda 3b: delta teórico alto vira motivo (não rebaixa sozinho); config incompleta limita a media.
if (delta_imposto_pct != null && Math.abs(delta_imposto_pct) > 0.25) {
  confianca.motivos.push(`Imposto realizado diverge ${(delta_imposto_pct * 100).toFixed(0)}% do teórico esperado — conferir competência/recolhimento.`);
}
if (!configTrib.completa && confianca.nivel === 'alta') {
  confianca.nivel = 'media';
  confianca.motivos.push('Config tributária incompleta — teórico parcial.');
}
```
E incluir `imposto_teorico`, `delta_imposto_pct` no objeto `detalhamento` do snapshot.

- [ ] **Step 5: deno check + re-deploy**

Run: `deno check supabase/functions/omie-financeiro/index.ts` → confirmar zero erro NOVO (comparar contagem de TS2571/TS2345/TS2578 com a do HEAD, devem ser iguais).
Entregar prompt de re-deploy pro chat do Lovable (ler o arquivo do repo, deploy verbatim). Commit:
```
git add supabase/functions/omie-financeiro/index.ts
git commit -m "feat(financeiro onda3b): imposto teórico no calcularDRE (espelho)"
```

---

## Task 6: SQL config + UI teórico×realizado

**Files:** Modify `src/services/financeiroService.ts`, `src/pages/FinanceiroCockpit.tsx`

- [ ] **Step 1: SQL opcional (entregar inline pro SQL Editor)**

```sql
ALTER TABLE fin_config_cashflow
  ADD COLUMN IF NOT EXISTS dre_tributario jsonb NOT NULL DEFAULT '{}'::jsonb;

SELECT 'DRE_TRIB OK' AS status, count(*) AS linhas FROM fin_config_cashflow;
```
Leitura defensiva no engine (Task 5) tolera ausência (maybeSingle → {}). Popular depois por empresa (ex.: `UPDATE fin_config_cashflow SET dre_tributario = '{"regime":"simples","anexo":"III"}'::jsonb WHERE company='colacor_sc';`).

- [ ] **Step 2: Tipo (financeiroService.ts)**

No `FinDRE.detalhamento`, adicionar:
```ts
    imposto_teorico?: Record<string, number | null> | null;
    delta_imposto_pct?: number | null;
    config_tributaria_completa?: boolean;
```

- [ ] **Step 3: UI (FinanceiroCockpit.tsx)**

Na seção de impostos (Onda 3a), ao lado do realizado, mostrar o teórico e o delta quando `dre.detalhamento?.imposto_teorico` existir:
```tsx
{dre.detalhamento?.imposto_teorico && (
  <div className="text-xs text-muted-foreground mt-1">
    Imposto teórico esperado: {fmt(Object.values(dre.detalhamento.imposto_teorico).reduce((s, v) => s + (v ?? 0), 0))}
    {dre.detalhamento.delta_imposto_pct != null && (
      <span className={Math.abs(dre.detalhamento.delta_imposto_pct) > 0.25 ? 'text-status-warning ml-1' : 'ml-1'}>
        (Δ {(dre.detalhamento.delta_imposto_pct * 100).toFixed(0)}% vs realizado)
      </span>
    )}
  </div>
)}
```

- [ ] **Step 4: Build** → `bun run build:dev` sem erro de tipo. Commit:
```
git add src/services/financeiroService.ts src/pages/FinanceiroCockpit.tsx
git commit -m "feat(financeiro onda3b): UI teórico×realizado + tipo + SQL config"
```

---

## Task 7: Docs + validação E2E

**Files:** Modify `docs/FINANCEIRO_CONFIABILIDADE.md`

- [ ] **Step 1: Seção Onda 3b** — explicar: teórico como conferência (não substitui realizado); Simples progressivo (RBT12/anexo/fator-r); presumido trimestral rateado + adicional; degradação honesta (`null`); delta alimenta confiança. Limitações documentadas: fator-r sem folha segregada não alterna anexo (degrade); rateio trimestral linear é aproximação; competência do DAS (mês anterior) não ajustada — vira motivo de delta.

- [ ] **Step 2: Suíte + lint + typecheck** — `bun run test` 100%; `bunx tsc --noEmit && bun run typecheck:strict`; `bunx eslint <arquivos da onda>`.

- [ ] **Step 3: Validação funcional (pós-deploy)** — Colacor SC (Simples) com `dre_tributario` `{regime:simples,anexo:III}`: DAS teórico aparece e bate na ordem de grandeza com o realizado; Colacor/Oben (presumido): IRPJ/CSLL/PIS/COFINS teóricos no fechamento do trimestre; delta >25% gera motivo de confiança.

- [ ] **Step 4: Commit** `docs(financeiro onda3b): seção imposto teórico em CONFIABILIDADE`.

---

## Self-Review (feito)

**1. Cobertura do spec (seção D + confiança delta):** RBT12 (T1), tabela anexo + efetiva + fator-r (T1/T2), teórico Simples e presumido trimestral + adicional (T3), config + degrade (T4), integração + delta na confiança (T5), SQL + UI (T6), docs (T7). ✅

**2. Placeholders:** sem TBD; código completo. Valores legais marcados com conferência obrigatória (não é placeholder — é dado real + passo de QA). ✅

**3. Consistência de tipos:** `AnexoSimples`/`FaixaSimples`/`ConfigTributario`/`ReceitaMensal` definidos em T1/T4 e reusados em T2/T3/T5; `impostoTeoricoSimples`/`impostoTeoricoPresumido`/`calcularRBT12`/`aliquotaEfetivaSimples`/`normalizarConfigTributario` — mesma assinatura no helper e no espelho do engine (T5). `detalhamento.{imposto_teorico,delta_imposto_pct,config_tributaria_completa}` definidos em T5 e lidos em T6. ✅

**Limitações conhecidas (documentadas, não bugs):** fator-r sem folha segregada não alterna anexo; rateio trimestral linear no presumido; competência do DAS (mês anterior) não realinhada — todas viram motivo de delta/confiança, não número inventado.
