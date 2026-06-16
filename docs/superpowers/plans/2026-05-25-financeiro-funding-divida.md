# Custo Marginal de Funding — Plano de Implementação (sub-PR A: Decisão de Antecipação)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development para executar tarefa-a-tarefa. Passos usam checkbox (`- [ ]`).

**Goal:** Entregar a decisão "vale antecipar este recebível?" por título de `fin_contas_receber`, em R$ no horizonte, comparando antecipação contra a fonte alternativa relevante (gap) ou o retorno do caixa (sobra), com degradação honesta. (sub-PR B — planejador de cobertura de gap — é plano separado, depois deste mergear.)

**Architecture:** Helper puro TDD `src/lib/financeiro/funding-helpers.ts` espelhado verbatim na edge function Deno `fin-funding` (master-only). Migration `fin_funding_inputs` (taxas default por empresa, RLS master-only). Reusa `cm_anual` de `empresa_configuracao_custos`, a projeção 13s de `fin-cashflow-engine` (via service_role) e os títulos de `fin_contas_receber`. Rota `/financeiro/funding` (master). Espelha o cadência/padrões de A2 (`fin-valor-engine`) e do Otimizador Tributário (`fin-regime-tributario`).

**Tech Stack:** TypeScript, vitest, Supabase (Postgres + RLS + Edge Functions Deno), React + React Query + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-05-25-financeiro-funding-divida-design.md`. Toda a metodologia (R$-no-horizonte, fronteira A4, gap×sobra, estrutural×calendário, IOF, CET, coobrigação) vive lá — esta é a execução.

---

### Task 0: Branch + spec (FEITO)

- [x] Branch `feat/financeiro-funding` criada de `origin/main`.
- [x] Spec commitada (`2c4d05e0`).

---

### Task 1: Helper — funções de custo (TDD)

**Files:**
- Create: `src/lib/financeiro/funding-helpers.ts`
- Test: `src/lib/financeiro/__tests__/funding-helpers.test.ts`

- [ ] **Step 1: Escrever os testes que falham** (`funding-helpers.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { iofCredito, custoEmReais, custoAntecipacao, custoOportunidadeCaixa } from '../funding-helpers';

describe('iofCredito', () => {
  it('aplica 0,38% fixo + 0,0082%/dia', () => {
    // 30 dias: 0,0038 + 0,000082*30 = 0,0038 + 0,00246 = 0,00626
    expect(iofCredito(1000, 30)).toBeCloseTo(1000 * 0.00626, 4);
  });
  it('limita a parcela diária a 365 dias', () => {
    expect(iofCredito(1000, 999)).toBeCloseTo(iofCredito(1000, 365), 6);
  });
  it('zero pra dias<=0', () => { expect(iofCredito(1000, 0)).toBe(1000 * 0.0038); });
});

describe('custoEmReais', () => {
  it('M*((1+r)^(D/365)-1)', () => {
    expect(custoEmReais(10000, 365, 0.20)).toBeCloseTo(2000, 2); // 1 ano a 20%
    expect(custoEmReais(10000, 30, 0.20)).toBeCloseTo(10000 * (Math.pow(1.2, 30/365) - 1), 4);
  });
  it('zero em inputs não-positivos', () => {
    expect(custoEmReais(0, 30, 0.2)).toBe(0);
    expect(custoEmReais(1000, 0, 0.2)).toBe(0);
    expect(custoEmReais(1000, 30, 0)).toBe(0);
  });
});

describe('custoAntecipacao', () => {
  it('desconto: deságio por fora + IOF + tarifa; custo_rs = V - v_liq', () => {
    const r = custoAntecipacao({ valor: 10000, dias: 30, taxa_desconto_mensal: 0.022, tipo: 'desconto', tarifa_fixa: 5 });
    const desagio = 10000 * 0.022 * (30/30); // 220
    const iof = 10000 * 0.00626;             // 62,6
    expect(r.desagio).toBeCloseTo(desagio, 4);
    expect(r.iof).toBeCloseTo(iof, 4);
    expect(r.v_liq).toBeCloseTo(10000 - desagio - iof - 5, 4);
    expect(r.custo_rs).toBeCloseTo(10000 - r.v_liq, 6);
    expect(r.taxa_efetiva_aa).toBeCloseTo(Math.pow(10000 / r.v_liq, 365/30) - 1, 6);
  });
  it('factoring: IOF zero', () => {
    const r = custoAntecipacao({ valor: 10000, dias: 30, taxa_desconto_mensal: 0.03, tipo: 'factoring' });
    expect(r.iof).toBe(0);
  });
  it('v_liq<=0 → taxa_efetiva null', () => {
    const r = custoAntecipacao({ valor: 100, dias: 30, taxa_desconto_mensal: 2, tipo: 'desconto' });
    expect(r.taxa_efetiva_aa).toBeNull();
  });
});

describe('custoOportunidadeCaixa', () => {
  it('ocioso → cm_anual', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: 0.4, ha_fila_a4_positiva: false, caixa_suficiente: true })).toBe(0.18);
  });
  it('fila A4 positiva + caixa insuficiente → max(cm, retorno A4)', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: 0.40, ha_fila_a4_positiva: true, caixa_suficiente: false })).toBe(0.40);
  });
  it('sem retorno A4 informado → cm_anual', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: null, ha_fila_a4_positiva: true, caixa_suficiente: false })).toBe(0.18);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test src/lib/financeiro/__tests__/funding-helpers.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar** (`funding-helpers.ts`)

```ts
// Custo Marginal de Funding — helper puro. Espelhado VERBATIM na edge function Deno
// supabase/functions/fin-funding/index.ts. Toda a metodologia: spec 2026-05-25-financeiro-funding-divida.
// Princípio: tudo em R$ no horizonte; taxa anualizada só pra exibir. Pré-imposto (sem tax-shield).

export type TipoFonte = 'caixa_proprio' | 'antecipacao' | 'capital_giro' | 'cheque_especial';

// IOF de operação de crédito PJ: 0,38% fixo + 0,0082%/dia (parcela diária limitada a 365 dias).
export function iofCredito(valor: number, dias: number): number {
  if (valor <= 0) return 0;
  const diasCap = Math.min(Math.max(dias, 0), 365);
  return valor * (0.000082 * diasCap + 0.0038);
}

// Custo em R$ de prover M reais por D dias a uma taxa anual efetiva (fração).
export function custoEmReais(M: number, dias: number, taxaAnual: number): number {
  if (M <= 0 || dias <= 0 || taxaAnual <= 0) return 0;
  return M * (Math.pow(1 + taxaAnual, dias / 365) - 1);
}

export type AntecipacaoResult = {
  desagio: number; iof: number; tarifa: number; v_liq: number;
  custo_rs: number; taxa_efetiva_aa: number | null;
};

// Antecipação/desconto de um título (face V, vence em N dias). Deságio comercial "por fora".
export function custoAntecipacao(input: {
  valor: number; dias: number; taxa_desconto_mensal: number; // fração a.m.
  tipo: 'desconto' | 'factoring'; tarifa_fixa?: number;
}): AntecipacaoResult {
  const { valor, dias } = input;
  const desagio = valor * input.taxa_desconto_mensal * (dias / 30);
  const iof = input.tipo === 'desconto' ? iofCredito(valor, dias) : 0;
  const tarifa = input.tarifa_fixa ?? 0;
  const v_liq = valor - desagio - iof - tarifa;
  const custo_rs = valor - v_liq;
  const taxa_efetiva_aa = v_liq > 0 && dias > 0 ? Math.pow(valor / v_liq, 365 / dias) - 1 : null;
  return { desagio, iof, tarifa, v_liq, custo_rs, taxa_efetiva_aa };
}

// Custo de oportunidade do caixa próprio (fração a.a.), sensível à alocação A4.
export function custoOportunidadeCaixa(input: {
  cm_anual: number;
  retorno_marginal_a4: number | null;
  ha_fila_a4_positiva: boolean;
  caixa_suficiente: boolean;
}): number {
  if (input.ha_fila_a4_positiva && !input.caixa_suficiente && input.retorno_marginal_a4 != null) {
    return Math.max(input.cm_anual, input.retorno_marginal_a4);
  }
  return input.cm_anual;
}
```

- [ ] **Step 4: Rodar e ver passar** — `heavy bun run test src/lib/financeiro/__tests__/funding-helpers.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add` os 2 arquivos; `git commit -m "feat(funding): helper de custo (IOF, custo em R$, antecipação, oportunidade) + testes"`.

---

### Task 2: Helper — contexto gap×sobra, vale-em-T, estrutural (TDD)

**Files:**
- Modify: `src/lib/financeiro/funding-helpers.ts`
- Modify: `src/lib/financeiro/__tests__/funding-helpers.test.ts`

- [ ] **Step 1: Testes que falham**

```ts
import { classificarContexto, checaValeEmT, classificarEstrutural, type Semana } from '../funding-helpers';

const semanas = (saldos: number[], entradas: Record<number, {id:string;valor:number}[]> = {}): Semana[] =>
  saldos.map((s, i) => ({
    inicio: `2026-W${i}`, fim: `2026-W${i}`, saldo_final: s, total_saidas: 0,
    entradas: (entradas[i] ?? []).map(e => ({ id_origem: e.id, data: `2026-W${i}`, valor: e.valor })),
  }));

describe('classificarContexto', () => {
  it('sem projeção → indefinido', () => {
    expect(classificarContexto({ tem_projecao: false, menor_saldo_ate_n: null, reserva_rs: 1000 })).toBe('indefinido');
  });
  it('menor saldo < reserva → gap', () => {
    expect(classificarContexto({ tem_projecao: true, menor_saldo_ate_n: 500, reserva_rs: 1000 })).toBe('gap');
  });
  it('menor saldo >= reserva → sobra', () => {
    expect(classificarContexto({ tem_projecao: true, menor_saldo_ate_n: 5000, reserva_rs: 1000 })).toBe('sobra');
  });
});

describe('checaValeEmT', () => {
  it('antecipar cria vale em T quando o recebimento era necessário', () => {
    // título T1 de 10000 entra na semana 2; saldos base [3000, 2500, 12000]; reserva 2000.
    // alt: +v_liq(9000) hoje, -10000 a partir da semana 2 → semana2 = 12000+9000-10000=11000 (ok)
    // troco pra um caso onde o vale aparece: saldos base [3000, 2500, 1500-ish]? Use saldo base que
    // depende da entrada. Caso: base [11000, 10500, 10000], entrada 10000 na semana 2, v_liq 1000, reserva 2000.
    // alt semana2 = 10000 + 1000 - 10000 = 1000 < 2000 (base 10000 >= 2000) → vale criado.
    const s = semanas([11000, 10500, 10000], { 2: [{ id: 'T1', valor: 10000 }] });
    expect(checaValeEmT({ semanas: s, titulo_id: 'T1', v_liq: 1000, reserva_rs: 2000 })).toBe(true);
  });
  it('não cria vale quando há folga', () => {
    const s = semanas([11000, 10500, 30000], { 2: [{ id: 'T1', valor: 10000 }] });
    expect(checaValeEmT({ semanas: s, titulo_id: 'T1', v_liq: 9000, reserva_rs: 2000 })).toBe(false);
  });
  it('título fora do horizonte (não está na projeção) → false', () => {
    const s = semanas([11000, 10500, 10000]);
    expect(checaValeEmT({ semanas: s, titulo_id: 'X', v_liq: 1000, reserva_rs: 2000 })).toBe(false);
  });
});

describe('classificarEstrutural', () => {
  it('gap em >= limiar semanas → estrutural', () => {
    const s = semanas([500, 500, 500, 500, 500, 500, 9000]); // 6 semanas < reserva 1000
    expect(classificarEstrutural({ semanas: s, reserva_rs: 1000, limiar_semanas: 6 })).toBe(true);
  });
  it('gap pontual → não estrutural', () => {
    const s = semanas([9000, 9000, 500, 9000]);
    expect(classificarEstrutural({ semanas: s, reserva_rs: 1000, limiar_semanas: 6 })).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar** (append em `funding-helpers.ts`)

```ts
export type Semana = {
  inicio: string; fim: string; saldo_final: number; total_saidas: number;
  entradas: { id_origem: string; data: string; valor: number }[];
};

export type Contexto = 'gap' | 'sobra' | 'indefinido';

export function classificarContexto(input: {
  tem_projecao: boolean; menor_saldo_ate_n: number | null; reserva_rs: number;
}): Contexto {
  if (!input.tem_projecao || input.menor_saldo_ate_n == null) return 'indefinido';
  return input.menor_saldo_ate_n < input.reserva_rs ? 'gap' : 'sobra';
}

// Simulação de 2 cenários: antecipar adiciona v_liq hoje e remove o recebimento (id_origem) na semana k.
// Delta sobre saldo_final: +v_liq em todas; -valorEntrada de k em diante. Vale criado se algum saldo
// de k em diante cai < reserva no alternativo mas estava >= reserva no base.
export function checaValeEmT(input: {
  semanas: Semana[]; titulo_id: string; v_liq: number; reserva_rs: number;
}): boolean {
  const { semanas, titulo_id, v_liq, reserva_rs } = input;
  const k = semanas.findIndex((s) => s.entradas.some((e) => e.id_origem === titulo_id));
  if (k < 0) return false;
  const valorEntrada = semanas[k].entradas
    .filter((e) => e.id_origem === titulo_id)
    .reduce((acc, e) => acc + e.valor, 0);
  for (let i = k; i < semanas.length; i++) {
    const base = semanas[i].saldo_final;
    const alt = base + v_liq - valorEntrada;
    if (alt < reserva_rs && base >= reserva_rs) return true;
  }
  return false;
}

export function classificarEstrutural(input: {
  semanas: Semana[]; reserva_rs: number; limiar_semanas: number;
}): boolean {
  const comGap = input.semanas.filter((s) => s.saldo_final < input.reserva_rs).length;
  return comGap >= input.limiar_semanas;
}
```

- [ ] **Step 4: Rodar e ver passar.**

- [ ] **Step 5: Commit** — `git commit -m "feat(funding): contexto gap×sobra, simulação 2-cenários e classificação estrutural"`.

---

### Task 3: Helper — decidirTitulo (composição) (TDD)

**Files:**
- Modify: `src/lib/financeiro/funding-helpers.ts`
- Modify: `src/lib/financeiro/__tests__/funding-helpers.test.ts`

- [ ] **Step 1: Testes que falham**

```ts
import { decidirTitulo } from '../funding-helpers';

const baseTitulo = { id: 'T1', valor: 10000, dias: 30, nome_cliente: 'ACME' };
const baseAnt = { taxa_desconto_mensal: 0.022, tipo: 'desconto' as const, coobrigacao: true };

describe('decidirTitulo', () => {
  it('GAP: antecipação mais barata que a alternativa → antecipar (net>0)', () => {
    // antecipação custo_rs ≈ 220+62,6 = 282,6. Cheque a 200% a.a. por 30d sobre v_liq ~9717:
    // custoEmReais(9717,30,2.0) ≈ 9717*((3)^(30/365)-1) ≈ 9717*0,0939 ≈ 912 → alt mais cara → antecipar.
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt,
      alternativas: { capital_giro_cet: null, cheque_cet: 2.0 },
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('antecipar');
    expect(d.net_rs!).toBeGreaterThan(0);
    expect(d.benchmark_fonte).toBe('cheque_especial');
    expect(d.flags).toContain('coobrigacao');
  });
  it('GAP: antecipação mais cara que dívida barata → não antecipar', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt,
      alternativas: { capital_giro_cet: 0.10, cheque_cet: null }, // 10% a.a. por 30d ≈ barato
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('nao_antecipar');
    expect(d.net_rs!).toBeLessThan(0);
  });
  it('SOBRA: deságio > cm_anual e sem uso A4 → não antecipar', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'sobra', flags_extra: [],
    });
    expect(d.recomendacao).toBe('nao_antecipar');
    expect(d.benchmark_fonte).toBe('caixa_proprio');
  });
  it('SOBRA com uso A4 de altíssimo retorno → antecipar', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: 0.18, retorno_marginal_a4: 5.0, contexto: 'sobra', flags_extra: [],
    });
    expect(d.recomendacao).toBe('antecipar');
    expect(d.benchmark_fonte).toBe('melhor_uso_a4');
  });
  it('GAP sem nenhuma alternativa informada → falta_dado', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('falta_dado');
  });
  it('v_liq<=0 → falta_dado', () => {
    const d = decidirTitulo({
      titulo: { id: 'T', valor: 100, dias: 30, nome_cliente: null },
      antecipacao: { taxa_desconto_mensal: 2, tipo: 'desconto', coobrigacao: false },
      alternativas: { cheque_cet: 2.0 }, cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('falta_dado');
  });
  it('indefinido (sem projeção) propaga flag sem_projecao', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'indefinido', flags_extra: [],
    });
    expect(d.flags).toContain('sem_projecao');
    expect(d.benchmark_fonte).toBe('caixa_proprio');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar** (append em `funding-helpers.ts`)

```ts
export type FonteBenchmark = TipoFonte | 'melhor_uso_a4';
export type Recomendacao = 'antecipar' | 'nao_antecipar' | 'falta_dado';

export type DecisaoTitulo = {
  titulo: { id: string; valor: number; dias: number; nome_cliente: string | null };
  v_liq: number;
  custo_rs_antecipacao: number;
  taxa_efetiva_aa: number | null;
  contexto: Contexto;
  benchmark_fonte: FonteBenchmark | null;
  custo_rs_benchmark: number | null;
  net_rs: number | null;
  recomendacao: Recomendacao;
  flags: string[];
};

export function decidirTitulo(input: {
  titulo: { id: string; valor: number; dias: number; nome_cliente?: string | null };
  antecipacao: { taxa_desconto_mensal: number; tipo: 'desconto' | 'factoring'; tarifa_fixa?: number; coobrigacao: boolean };
  alternativas: { capital_giro_cet?: number | null; cheque_cet?: number | null };
  cm_anual: number;
  retorno_marginal_a4: number | null;
  contexto: Contexto;
  flags_extra: string[];
}): DecisaoTitulo {
  const t = { id: input.titulo.id, valor: input.titulo.valor, dias: input.titulo.dias, nome_cliente: input.titulo.nome_cliente ?? null };
  const ant = custoAntecipacao({ valor: t.valor, dias: t.dias, taxa_desconto_mensal: input.antecipacao.taxa_desconto_mensal, tipo: input.antecipacao.tipo, tarifa_fixa: input.antecipacao.tarifa_fixa });
  const flags = [...input.flags_extra];
  if (input.antecipacao.coobrigacao) flags.push('coobrigacao');

  const base: DecisaoTitulo = {
    titulo: t, v_liq: ant.v_liq, custo_rs_antecipacao: ant.custo_rs, taxa_efetiva_aa: ant.taxa_efetiva_aa,
    contexto: input.contexto, benchmark_fonte: null, custo_rs_benchmark: null, net_rs: null, recomendacao: 'falta_dado', flags,
  };
  if (ant.v_liq <= 0) return base;

  if (input.contexto === 'gap') {
    const cands: { fonte: FonteBenchmark; custo: number }[] = [];
    if (input.alternativas.capital_giro_cet != null) cands.push({ fonte: 'capital_giro', custo: custoEmReais(ant.v_liq, t.dias, input.alternativas.capital_giro_cet) });
    if (input.alternativas.cheque_cet != null) cands.push({ fonte: 'cheque_especial', custo: custoEmReais(ant.v_liq, t.dias, input.alternativas.cheque_cet) });
    if (cands.length === 0) return base; // falta_dado: nenhuma fonte de substituição
    const melhor = cands.reduce((a, b) => (b.custo < a.custo ? b : a));
    const net = melhor.custo - ant.custo_rs;
    return { ...base, benchmark_fonte: melhor.fonte, custo_rs_benchmark: melhor.custo, net_rs: net, recomendacao: net > 0 ? 'antecipar' : 'nao_antecipar' };
  }

  // sobra | indefinido: o caixa liberado renderia rBench; antecipar vale se ganho > custo.
  const rBench = input.retorno_marginal_a4 != null ? Math.max(input.cm_anual, input.retorno_marginal_a4) : input.cm_anual;
  const ganho = custoEmReais(ant.v_liq, t.dias, rBench);
  const net = ganho - ant.custo_rs;
  const benchmark_fonte: FonteBenchmark = input.retorno_marginal_a4 != null ? 'melhor_uso_a4' : 'caixa_proprio';
  if (input.contexto === 'indefinido') flags.push('sem_projecao');
  return { ...base, benchmark_fonte, custo_rs_benchmark: ganho, net_rs: net, recomendacao: net > 0 ? 'antecipar' : 'nao_antecipar' };
}
```

- [ ] **Step 4: Rodar e ver passar.** Rodar a suíte do helper inteira: `heavy bun run test src/lib/financeiro/__tests__/funding-helpers.test.ts`.

- [ ] **Step 5: Commit** — `git commit -m "feat(funding): decidirTitulo compõe custo+contexto+benchmark com degradação honesta"`.

---

### Task 4: Migration `fin_funding_inputs` (master-only)

**Files:**
- Create: `supabase/migrations/20260526100000_fin_funding_inputs.sql`

- [ ] **Step 1: Escrever a migration** (espelha `20260524120000_fin_regime_inputs.sql`)

```sql
-- supabase/migrations/20260526100000_fin_funding_inputs.sql
-- Custo Marginal de Funding: taxas default das fontes por empresa, TABELA master-only.
-- O engine fin-funding usa service_role (bypassa RLS); o app só lê/escreve como master. Idempotente.

CREATE TABLE IF NOT EXISTS fin_funding_inputs (
  company        text PRIMARY KEY,
  funding_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

COMMENT ON COLUMN fin_funding_inputs.funding_inputs IS
  'Funding: { fontes: { antecipacao: {taxa_desconto_mensal_perc, tarifa_fixa, tipo: desconto|factoring, coobrigacao, ativo}, capital_giro: {cet_anual_perc, ativo}, cheque_especial: {cet_anual_perc, ativo} }, reserva_dias_min, gap_estrutural_semanas_min }';

ALTER TABLE fin_funding_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_funding_inputs_select_master ON fin_funding_inputs;
CREATE POLICY fin_funding_inputs_select_master ON fin_funding_inputs
  FOR SELECT USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_funding_inputs_write_master ON fin_funding_inputs;
CREATE POLICY fin_funding_inputs_write_master ON fin_funding_inputs
  FOR ALL USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

INSERT INTO fin_funding_inputs (company) VALUES ('colacor'), ('oben'), ('colacor_sc')
  ON CONFLICT (company) DO NOTHING;

SELECT 'fin_funding_inputs OK' AS status,
  (SELECT count(*) FROM fin_funding_inputs) AS linhas,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'fin_funding_inputs') AS policies;
```

- [ ] **Step 2: Anotar no corpo do PR** que esta migration é **manual** (colar no SQL Editor do Lovable) — entrega inline na conversa no fim (Task 8). Sem rodar nada local (não há acesso ao banco).

- [ ] **Step 3: Commit** — `git commit -m "feat(funding): migration fin_funding_inputs (taxas por empresa, RLS master-only)"`.

---

### Task 5: Edge function `fin-funding` (Deno, master-only, espelha helper)

**Files:**
- Create: `supabase/functions/fin-funding/index.ts`

**Contexto pro implementador:** espelhe a estrutura de `supabase/functions/fin-regime-tributario/index.ts` (auth master-only via `user_roles`) e de `fin-next-best-action/index.ts` (composição via service_role + `Promise.all`). As funções puras do helper (`iofCredito`, `custoEmReais`, `custoAntecipacao`, `custoOportunidadeCaixa`, `classificarContexto`, `checaValeEmT`, `classificarEstrutural`, `decidirTitulo`, e os tipos) devem ser **copiadas VERBATIM** (sem `@/`, tipos inline, aspas duplas) no topo do arquivo — não reimplementar a matemática.

- [ ] **Step 1: Implementar** com este fluxo (request: `{ company }`):
  1. `validateCaller` (master-only) — copie de `fin-regime-tributario`.
  2. Lê `fin_funding_inputs` (a linha da empresa) via service_role → as taxas. Converte percentuais (`*_perc`/100) pra fração.
  3. Lê `cm_anual` de `empresa_configuracao_custos` (`empresa = company`): `cm_anual = (selic_anual + spread_oportunidade + armazenagem_fisica)/100`. Se ausente → flag + `cm_anual` null (degrada).
  4. Compõe a projeção 13s: `fetch` POST em `${SUPABASE_URL}/functions/v1/fin-cashflow-engine` (Authorization Bearer service_role) com `{ company, cenario: 'realista', horizon_weeks: 13 }`. Pega `semanas[]`. Se falhar/timeout (use `AbortController`, ~20s) → `tem_projecao=false` (degrada pra contexto 'indefinido').
  5. Deriva `reserva_rs`: burn diário = `Σ total_saidas / (13*7)`; `reserva_rs = burn_diario * reserva_dias_min`. `estrutural = classificarEstrutural({ semanas, reserva_rs, limiar_semanas: gap_estrutural_semanas_min })`.
  6. Lê títulos antecipáveis de `fin_contas_receber`: `company = eq`, `status_titulo = ABERTO`, `saldo > 0`, `data_vencimento > hoje`. Paginação fetchAll (PostgREST capa 1000 — espelhe o padrão anti-truncamento do `fin-valor-cockpit`).
  7. Pra cada título: `dias = diasEntre(hoje, data_vencimento)`. `menor_saldo_ate_n` = menor `saldo_final` das semanas cujo `fim <= data_vencimento`. `contexto = classificarContexto(...)`. Roda `decidirTitulo(...)` com as alternativas `capital_giro_cet`/`cheque_cet` (só fontes `ativo`). Se `checaValeEmT(...)` → push flag `'cria_vale_em_T'`. Se `estrutural` → push flag `'estrutural'`. Concentração por sacado (aviso): se a soma antecipável do mesmo `nome_cliente` > X% do total → flag `'concentracao_sacado'` (X do thresholds `concentracao_top1_max_pct` de `fin_config_cashflow`, default 20).
  8. Retorna `{ company, gerado_em, cm_anual, tem_projecao, estrutural, reserva_rs, titulos: DecisaoTitulo[], confianca: { nivel, motivos } }`. Ordena `titulos` por `net_rs` desc (antecipar primeiro), `falta_dado` por último.
  9. `retorno_marginal_a4` fica **null no sub-PR A** (composição A4 completa é sub-PR B) — a sobra usa `cm_anual`. Deixe um TODO claro marcando o ponto de plug do A4.

- [ ] **Step 2: Validar sintaxe** — `deno check supabase/functions/fin-funding/index.ts` (se `deno` disponível; senão `bunx --bun deno check` ou pular com nota).

- [ ] **Step 3: Verificar paridade helper↔engine** — diff visual das funções puras copiadas vs `funding-helpers.ts` (devem ser idênticas em lógica). Anotar no PR.

- [ ] **Step 4: Commit** — `git commit -m "feat(funding): edge function fin-funding (master-only, compõe projeção 13s + cm_anual)"`.

---

### Task 6: Tipos + hook `useFunding` + dialog `FundingInputsDialog`

**Files:**
- Modify: `src/services/financeiroService.ts` (tipos do contrato `FundingResult`/`DecisaoTituloDTO`, espelhando o retorno da edge)
- Create: `src/hooks/useFunding.ts` (espelha `src/hooks/useRegimeTributario.ts`)
- Create: `src/components/financeiro/FundingInputsDialog.tsx` (espelha `src/components/financeiro/RegimeInputsDialog.tsx`)

- [ ] **Step 1: Tipos** em `financeiroService.ts` — tipo do retorno da função (campos do Step 8 da Task 5). Reutilize o shape de `DecisaoTitulo`.

- [ ] **Step 2: Hook `useFunding(company)`** — `useQuery` chamando `supabase.functions.invoke('fin-funding', { body: { company } })`; e um `useMutation` `salvarFundingInputs` que faz `upsert` em `fin_funding_inputs` (cast minimal-client-shape **através de `unknown`**, NÃO `as ReturnType<typeof supabase.from>` — ver lição §5/§10 do CLAUDE.md sobre a divergência de postgrest-js no Lovable). Padrão exato do upsert em `useRegimeTributario.ts`.

- [ ] **Step 3: Dialog** `FundingInputsDialog` — formulário das taxas das 3 fontes (taxa_desconto_mensal_perc, tipo desconto/factoring, coobrigacao, tarifa_fixa; cet_anual_perc de capital_giro e cheque_especial; reserva_dias_min; gap_estrutural_semanas_min) + `ativo` por fonte. Salva via `salvarFundingInputs`. Espelha o layout do `RegimeInputsDialog`.

- [ ] **Step 4: Verificar typecheck** — `heavy bun run typecheck:strict` (se os arquivos novos entrarem no include) + `bunx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git commit -m "feat(funding): tipos + useFunding + FundingInputsDialog"`.

---

### Task 7: Página `/financeiro/funding` + rota + sidebar (master-only)

**Files:**
- Create: `src/pages/FinanceiroFunding.tsx`
- Modify: `src/App.tsx` (lazy route `/financeiro/funding`)
- Modify: `src/components/AppShell.tsx` (item de sidebar na seção Financeiro, `masterOnly`, ícone `Landmark` ou `Banknote` de lucide-react)

- [ ] **Step 1: Página** — espelha `src/pages/FinanceiroRegimeTributario.tsx`:
  - Header com `font-display`, seletor de empresa (CompanyContext), botão "Editar taxas" abrindo o `FundingInputsDialog`.
  - Estado de loading → `<PageSkeleton variant="cockpit" />`.
  - Lista/tabela de **títulos antecipáveis** com colunas: cliente, valor, vence em (dias), v_líq, custo R$ antecipação, taxa efetiva a.a. (exibição), contexto (gap/sobra/indefinido badge), benchmark, **net R$** (destaque, verde/vermelho via `text-status-*`), recomendação (badge `antecipar`/`não antecipar`/`falta dado`), flags (coobrigação/cria vale em T/estrutural/concentração/sem projeção como chips).
  - Banner no topo quando `estrutural` = true: "⚠️ Gap recorrente nas próximas semanas — isto é estrutural. Antecipar recebível é rolagem; priorize renegociar prazo de fornecedor/cliente, preço/margem ou dívida de prazo adequado."
  - Drawer/expand por título mostrando a decomposição (deságio, IOF, tarifa, custo do benchmark) e o texto do "porquê".
  - Degradação: sem projeção → aviso "Projeção 13s indisponível — decisão usa custo de oportunidade do caixa (cm_anual); sem detecção de gap/sobra nem aviso de vale."
- [ ] **Step 2: Rota** em `App.tsx` (lazy, dentro do grupo financeiro) + **sidebar** em `AppShell.tsx` (`masterOnly: true`).
- [ ] **Step 3: Verificar** — `heavy bun run typecheck:strict` + `bunx tsc --noEmit` + `bun lint`.
- [ ] **Step 4: Commit** — `git commit -m "feat(funding): página /financeiro/funding + rota + sidebar (master)"`.

---

### Task 8: Docs + validação final + Codex adversarial + PR

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md` (seção do Custo Marginal de Funding — metodologia, fontes de dados, degradação)

- [ ] **Step 1: Doc** — adicionar a seção (espelha as seções A2/regime): o que entra (4 fontes), o princípio R$-no-horizonte, a fronteira A4, gap×sobra, estrutural×calendário, IOF/CET/coobrigação, degradação honesta, e o que ficou pro sub-PR B / v2.
- [ ] **Step 2: Suíte completa + build** — `heavy bun run test` (tudo verde) + `heavy bun run typecheck:strict` + `bunx tsc --noEmit` + `bun lint` + `heavy bun build`.
- [ ] **Step 3: Codex adversarial no CÓDIGO** — `codex exec` (read-only) apontando pra `src/lib/financeiro/funding-helpers.ts` + `supabase/functions/fin-funding/index.ts`: "tente quebrar — algum caso onde a recomendação inverte, double-count com A4, erro de sinal no net_rs, IOF/anualização, ou divergência helper↔engine?". Incorporar findings P1/P2.
- [ ] **Step 4: PR** — push `feat/financeiro-funding`; `gh pr create` com corpo incluindo **"ATENÇÃO: migration manual"** + o bloco SQL da Task 4 + instrução de deploy da edge `fin-funding` via chat do Lovable. Auto-merge `--squash --auto` quando o `validate` passar.
- [ ] **Step 5: Entregáveis pro founder** (na conversa): bloco SQL da migration (fenced ```sql, pronto pro SQL Editor) + prompt de deploy da edge function via chat do Lovable + a query de validação.

---

## Notas de execução

- **Modelo:** Tasks 1-3 (helper puro, spec completa) = modelo barato/rápido. Task 5 (edge, composição) e 7 (página) = modelo padrão. Task 8 review = mais capaz.
- **Heavy:** prefixar test/build/typecheck com `heavy` (máquina M2 8GB, sessões paralelas).
- **Lovable:** migration manual (founder cola no SQL Editor) + deploy da edge via chat do Lovable após merge. Sem CLI/terminal pro backend.
- **sub-PR B (depois):** plano separado — compõe `fin-next-best-action` (caixa_livre + retorno_marginal), o planejador merit-order em R$, custo da inércia em R$, e o re-custo completo do vale-em-T.
