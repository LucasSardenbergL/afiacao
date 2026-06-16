# Financeiro A4 — Próxima Melhor Ação (Next-Best-Action) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a Fila de Próxima Melhor Ação — uma lista priorizada de ações concretas (consertar valor → liberar caixa → crescer → benchmark) sob a restrição de caixa de cada empresa, com status, compondo A1/A2/A3.

**Architecture:** Helper puro testável (`src/lib/financeiro/next-best-action-helpers.ts`, vitest) espelhado num engine Deno fino (`fin-next-best-action`, gate gestor+master) que usa service_role pra chamar internamente `fin-cashflow-engine`, `fin-valor-engine` e `fin-valor-cockpit` (todas aceitam service_role), normaliza em "candidatos de ação", e devolve a fila ordenada + com status. Frontend: hook `useProximaAcao` + página `/financeiro/proxima-acao`.

**Tech Stack:** React 18 + TS + Vite + @tanstack/react-query + shadcn/ui + Tailwind (status-* tokens); Supabase Edge Function Deno; vitest; `deno check`.

---

## Fonte da verdade

Spec: `docs/superpowers/specs/2026-05-24-financeiro-a4-proxima-acao-design.md` (commitado `9b79e62`). Re-escopado por Codex: fila de ações, não alocador textbook.

## Dependências (contratos das functions internas — já em produção no código)

- `fin-cashflow-engine` body `{ company, cenario?, horizon_weeks? }` → `CashflowResult` com `indicadores: { dias_cobertura, saldo_tesouraria, liquidez_operacional_liquida, ... }` e `ncg: { valor, ... }`.
- `fin-valor-engine` body `{ company }` → `ValorEmpresaResult` com `reportado: { wacc, spread, roic_incremental, ... }` e `confianca`.
- `fin-valor-cockpit` body `{}` (Oben fixo) → `ValorCockpitResult` com `recomendacoesCliente: [{ cliente, recomendacoes: [{ acao, motivo, impacto_rs }] }]` e `confianca`.
- ⚠️ A2 (`fin-valor-engine`) e A3 (`fin-valor-cockpit`) ainda **não estão deployadas** no Lovable (deploy manual pendente). A4 degrada honesto se uma function interna falhar (status `Falta dado`). O código de A4 pode ser construído/testado antes do deploy.

## Estado da branch

Branch `feat/financeiro-a4-proxima-acao` criada de `origin/main` (já com A1/A2/A3). Spec commitado (`9b79e62`). Commits locais por task; sem push até o founder pedir.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/lib/financeiro/next-best-action-helpers.ts` | Puro: caixa disponível, hurdle efetivo, classificação de status, ordenação, montagem da fila. | Criar |
| `src/lib/financeiro/__tests__/next-best-action-helpers.test.ts` | Testes vitest. | Criar |
| `supabase/functions/fin-next-best-action/index.ts` | Engine fino (gestor+master). Chama as 3 functions via service_role, normaliza em candidatos, espelha o helper. | Criar |
| `src/services/financeiroService.ts` | Tipos `AcaoFila`, `ProximaAcaoResult`. | Modificar |
| `src/hooks/useProximaAcao.ts` | Hook react-query (invoca a function). | Criar |
| `src/pages/FinanceiroProximaAcao.tsx` | Página `/financeiro/proxima-acao` (gestor+master): fila agrupada por status. | Criar |
| `src/App.tsx` | Lazy import + rota. | Modificar |
| `src/components/AppShell.tsx` | Link sidebar (gestor+master). | Modificar |
| `docs/FINANCEIRO_CONFIABILIDADE.md` | Seção A4. | Modificar |

---

## Contrato de tipos (referência única)

```ts
export type StatusAcao = 'financiar_ja' | 'financiar_condicional' | 'consertar_antes' | 'falta_dado' | 'nao_financiar';
export type TipoAcao = 'consertar_valor' | 'liberar_caixa' | 'crescer' | 'benchmark';

// candidato de ação ANTES de status/ordem (o engine extrai de A1/A2/A3)
export type AcaoCandidata = {
  empresa: string;
  descricao: string;
  tipo: TipoAcao;
  impacto_eva: number | null;       // R$/ano
  caixa_consumido: number | null;   // pico; 0 = não custa caixa; null = desconhecido
  payback_meses: number | null;
  spread_positivo: boolean | null;  // ROIC/EVA acima do hurdle? null = sem dado
  confianca: 'alta' | 'media' | 'baixa';
};

export type AcaoFila = AcaoCandidata & { hurdle: number | null; status: StatusAcao };

export type ProximaAcaoResult = {
  fila: AcaoFila[];                  // ordenada
  caixa_por_empresa: Record<string, { disponivel: number; confianca: 'alta' | 'media' | 'baixa' }>;
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  gerado_em: string;
};
```

Prioridade de tipo (ordem): `consertar_valor` (0) < `liberar_caixa` (1) < `crescer` (2) < `benchmark` (3).

---

## Task 0: Confirmar branch + spec

- [ ] **Step 1**
```bash
git branch --show-current   # feat/financeiro-a4-proxima-acao
test -f docs/superpowers/specs/2026-05-24-financeiro-a4-proxima-acao-design.md && echo "spec OK"
test -d node_modules || bun install
```

---

## Task 1: `caixaDisponivel` + `hurdleEfetivo`

**Files:**
- Create: `src/lib/financeiro/next-best-action-helpers.ts`
- Test: `src/lib/financeiro/__tests__/next-best-action-helpers.test.ts`

- [ ] **Step 1: Testes que falham**

```ts
// src/lib/financeiro/__tests__/next-best-action-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { caixaDisponivel, hurdleEfetivo } from '../next-best-action-helpers';

describe('caixaDisponivel', () => {
  it('saldo − reserva proporcional aos dias de cobertura', () => {
    // cobre 60 dias com 120k; reserva mínima 30 dias → reserva = 120k×30/60 = 60k → disp 60k
    expect(caixaDisponivel({ saldo_tesouraria: 120000, dias_cobertura: 60, reserva_dias_min: 30, confianca_baixa: false })).toBeCloseTo(60000, 0);
  });
  it('cobertura abaixo da reserva mínima → 0 disponível', () => {
    expect(caixaDisponivel({ saldo_tesouraria: 50000, dias_cobertura: 20, reserva_dias_min: 30, confianca_baixa: false })).toBe(0);
  });
  it('confiança baixa → haircut de 50%', () => {
    expect(caixaDisponivel({ saldo_tesouraria: 120000, dias_cobertura: 60, reserva_dias_min: 30, confianca_baixa: true })).toBeCloseTo(30000, 0);
  });
  it('dias_cobertura 0/desconhecido → reserva tudo (0 disponível)', () => {
    expect(caixaDisponivel({ saldo_tesouraria: 100000, dias_cobertura: 0, reserva_dias_min: 30, confianca_baixa: false })).toBe(0);
  });
});

describe('hurdleEfetivo', () => {
  it('WACC presente → usa WACC (fonte wacc)', () => {
    const r = hurdleEfetivo({ wacc: 0.2, custo_divida_pos_imposto: 0.14, retorno_minimo_dono: 0.25, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.2); expect(r.fonte).toBe('wacc');
  });
  it('sem WACC → retorno do dono (fonte retorno_dono)', () => {
    const r = hurdleEfetivo({ wacc: null, custo_divida_pos_imposto: 0.14, retorno_minimo_dono: 0.25, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.25); expect(r.fonte).toBe('retorno_dono');
  });
  it('sem WACC nem dono → custo de dívida', () => {
    const r = hurdleEfetivo({ wacc: null, custo_divida_pos_imposto: 0.14, retorno_minimo_dono: null, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.14); expect(r.fonte).toBe('custo_divida');
  });
  it('só mediana → mediana', () => {
    const r = hurdleEfetivo({ wacc: null, custo_divida_pos_imposto: null, retorno_minimo_dono: null, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.18); expect(r.fonte).toBe('mediana');
  });
  it('nada → null + indisponivel', () => {
    const r = hurdleEfetivo({ wacc: null, custo_divida_pos_imposto: null, retorno_minimo_dono: null, mediana_hurdles: null });
    expect(r.hurdle).toBeNull(); expect(r.fonte).toBe('indisponivel');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- next-best-action-helpers`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementação**

```ts
// src/lib/financeiro/next-best-action-helpers.ts
// A4 — Próxima Melhor Ação. Módulo puro, espelhado verbatim na edge function Deno
// supabase/functions/fin-next-best-action/index.ts. Compõe A1/A2/A3 numa fila priorizada.

export function caixaDisponivel(input: {
  saldo_tesouraria: number;
  dias_cobertura: number;
  reserva_dias_min: number;
  confianca_baixa: boolean;
}): number {
  if (input.dias_cobertura <= 0) return 0; // cobertura desconhecida → conservador, reserva tudo
  const fracaoReserva = Math.min(1, input.reserva_dias_min / input.dias_cobertura);
  let disp = input.saldo_tesouraria * (1 - fracaoReserva);
  if (input.confianca_baixa) disp *= 0.5; // haircut quando a projeção de caixa é incerta
  return Math.max(0, disp);
}

export type FonteHurdle = 'wacc' | 'retorno_dono' | 'custo_divida' | 'mediana' | 'indisponivel';

export function hurdleEfetivo(input: {
  wacc: number | null;
  custo_divida_pos_imposto: number | null;
  retorno_minimo_dono: number | null;
  mediana_hurdles: number | null;
}): { hurdle: number | null; fonte: FonteHurdle } {
  if (input.wacc != null) return { hurdle: input.wacc, fonte: 'wacc' };
  if (input.retorno_minimo_dono != null) return { hurdle: input.retorno_minimo_dono, fonte: 'retorno_dono' };
  if (input.custo_divida_pos_imposto != null) return { hurdle: input.custo_divida_pos_imposto, fonte: 'custo_divida' };
  if (input.mediana_hurdles != null) return { hurdle: input.mediana_hurdles, fonte: 'mediana' };
  return { hurdle: null, fonte: 'indisponivel' };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- next-best-action-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/next-best-action-helpers.ts src/lib/financeiro/__tests__/next-best-action-helpers.test.ts
git commit -m "feat(financeiro a4): caixaDisponivel + hurdleEfetivo (com fallbacks honestos)"
```

---

## Task 2: `classificarStatus`

**Files:**
- Modify: `src/lib/financeiro/next-best-action-helpers.ts`
- Test: `src/lib/financeiro/__tests__/next-best-action-helpers.test.ts`

- [ ] **Step 1: Testes que falham**

```ts
import { classificarStatus } from '../next-best-action-helpers';

describe('classificarStatus', () => {
  it('consertar_valor com EVA+ → consertar_antes (faz primeiro, custo de caixa ~0)', () => {
    expect(classificarStatus({ tipo: 'consertar_valor', impacto_eva: 5000, spread_positivo: null, caixa_consumido: 0, caixa_disponivel: 0, hurdle: 0.2, tem_dado: true })).toBe('consertar_antes');
  });
  it('liberar_caixa → consertar_antes', () => {
    expect(classificarStatus({ tipo: 'liberar_caixa', impacto_eva: 0, spread_positivo: null, caixa_consumido: 0, caixa_disponivel: 0, hurdle: 0.2, tem_dado: true })).toBe('consertar_antes');
  });
  it('crescer spread+ com caixa suficiente → financiar_ja', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: 8000, spread_positivo: true, caixa_consumido: 40000, caixa_disponivel: 60000, hurdle: 0.2, tem_dado: true })).toBe('financiar_ja');
  });
  it('crescer spread+ SEM caixa → financiar_condicional', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: 8000, spread_positivo: true, caixa_consumido: 80000, caixa_disponivel: 10000, hurdle: 0.2, tem_dado: true })).toBe('financiar_condicional');
  });
  it('crescer spread NEGATIVO → nao_financiar', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: -1, spread_positivo: false, caixa_consumido: 10000, caixa_disponivel: 99999, hurdle: 0.2, tem_dado: true })).toBe('nao_financiar');
  });
  it('sem dado (hurdle/sinal ausente) → falta_dado', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: null, spread_positivo: null, caixa_consumido: null, caixa_disponivel: 0, hurdle: null, tem_dado: false })).toBe('falta_dado');
  });
  it('benchmark → nao_financiar (é o piso quando nada supera o hurdle)', () => {
    expect(classificarStatus({ tipo: 'benchmark', impacto_eva: null, spread_positivo: null, caixa_consumido: 0, caixa_disponivel: 0, hurdle: 0.2, tem_dado: true })).toBe('nao_financiar');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- next-best-action-helpers`
Expected: FAIL — `classificarStatus is not a function`.

- [ ] **Step 3: Implementação (append)**

```ts
export type StatusAcao = 'financiar_ja' | 'financiar_condicional' | 'consertar_antes' | 'falta_dado' | 'nao_financiar';
export type TipoAcao = 'consertar_valor' | 'liberar_caixa' | 'crescer' | 'benchmark';

export function classificarStatus(input: {
  tipo: TipoAcao;
  impacto_eva: number | null;
  spread_positivo: boolean | null;
  caixa_consumido: number | null;
  caixa_disponivel: number;
  hurdle: number | null;
  tem_dado: boolean;
}): StatusAcao {
  if (!input.tem_dado) return 'falta_dado';
  if (input.tipo === 'benchmark') return 'nao_financiar';
  // consertar valor / liberar caixa: fazer primeiro (custo de caixa ~0, gera valor/solta caixa)
  if (input.tipo === 'consertar_valor' || input.tipo === 'liberar_caixa') return 'consertar_antes';
  // crescer: precisa bater o hurdle (spread positivo)
  if (input.tipo === 'crescer') {
    if (input.spread_positivo !== true) return 'nao_financiar';
    const custo = input.caixa_consumido ?? 0;
    return custo <= input.caixa_disponivel ? 'financiar_ja' : 'financiar_condicional';
  }
  return 'falta_dado';
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- next-best-action-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/next-best-action-helpers.ts src/lib/financeiro/__tests__/next-best-action-helpers.test.ts
git commit -m "feat(financeiro a4): classificarStatus (consertar antes de crescer; hurdle como corte)"
```

---

## Task 3: `montarFilaAcoes` (ordena + atribui status + confiança)

**Files:**
- Modify: `src/lib/financeiro/next-best-action-helpers.ts`
- Test: `src/lib/financeiro/__tests__/next-best-action-helpers.test.ts`

- [ ] **Step 1: Testes que falham**

```ts
import { montarFilaAcoes } from '../next-best-action-helpers';

const cand = (over: Partial<import('../next-best-action-helpers').AcaoCandidata>): import('../next-best-action-helpers').AcaoCandidata => ({
  empresa: 'oben', descricao: 'x', tipo: 'crescer', impacto_eva: 1000, caixa_consumido: 0, payback_meses: null, spread_positivo: true, confianca: 'alta', ...over,
});

describe('montarFilaAcoes', () => {
  it('ordena por tipo (consertar→liberar→crescer→benchmark) e injeta benchmark', () => {
    const r = montarFilaAcoes({
      candidatos: [
        cand({ tipo: 'crescer', descricao: 'crescer A' }),
        cand({ tipo: 'consertar_valor', descricao: 'cortar desconto', impacto_eva: 500, caixa_consumido: 0 }),
      ],
      caixaPorEmpresa: { oben: { disponivel: 100000, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    expect(r.fila[0].tipo).toBe('consertar_valor');
    expect(r.fila.some((a) => a.tipo === 'benchmark')).toBe(true); // benchmark sempre presente
    expect(r.fila[r.fila.length - 1].tipo).toBe('benchmark');
  });

  it('dentro do mesmo tipo, ações sem caixa (preço/prazo) vêm antes; depois por EVA/caixa', () => {
    const r = montarFilaAcoes({
      candidatos: [
        cand({ tipo: 'crescer', descricao: 'cresce caro', impacto_eva: 10000, caixa_consumido: 100000 }),
        cand({ tipo: 'crescer', descricao: 'cresce barato', impacto_eva: 5000, caixa_consumido: 10000 }),
      ],
      caixaPorEmpresa: { oben: { disponivel: 200000, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    const crescer = r.fila.filter((a) => a.tipo === 'crescer');
    expect(crescer[0].descricao).toBe('cresce barato'); // EVA/caixa = 0.5 > 0.1
  });

  it('hurdle ausente p/ empresa → status falta_dado nas ações de crescer dela', () => {
    const r = montarFilaAcoes({
      candidatos: [cand({ empresa: 'colacor', tipo: 'crescer', spread_positivo: null })],
      caixaPorEmpresa: { colacor: { disponivel: 50000, confianca: 'media' } },
      hurdlePorEmpresa: {}, // sem hurdle p/ colacor
    });
    const a = r.fila.find((x) => x.empresa === 'colacor')!;
    expect(a.status).toBe('falta_dado');
    expect(a.hurdle).toBeNull();
  });

  it('caixa de uma empresa não financia ação de outra', () => {
    const r = montarFilaAcoes({
      candidatos: [cand({ empresa: 'oben', tipo: 'crescer', caixa_consumido: 40000, spread_positivo: true })],
      caixaPorEmpresa: { oben: { disponivel: 10000, confianca: 'alta' }, colacor: { disponivel: 999999, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    // caixa da Oben (10k) < custo (40k) → condicional, ignora o caixa enorme da Colacor
    expect(r.fila.find((a) => a.empresa === 'oben' && a.tipo === 'crescer')!.status).toBe('financiar_condicional');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- next-best-action-helpers`
Expected: FAIL — `montarFilaAcoes is not a function`.

- [ ] **Step 3: Implementação (append)**

```ts
export type AcaoCandidata = {
  empresa: string;
  descricao: string;
  tipo: TipoAcao;
  impacto_eva: number | null;
  caixa_consumido: number | null;
  payback_meses: number | null;
  spread_positivo: boolean | null;
  confianca: 'alta' | 'media' | 'baixa';
};
export type AcaoFila = AcaoCandidata & { hurdle: number | null; status: StatusAcao };
export type ProximaAcaoResult = {
  fila: AcaoFila[];
  caixa_por_empresa: Record<string, { disponivel: number; confianca: 'alta' | 'media' | 'baixa' }>;
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  gerado_em: string;
};

const PRIORIDADE_TIPO: Record<TipoAcao, number> = { consertar_valor: 0, liberar_caixa: 1, crescer: 2, benchmark: 3 };

export function montarFilaAcoes(input: {
  candidatos: AcaoCandidata[];
  caixaPorEmpresa: Record<string, { disponivel: number; confianca: 'alta' | 'media' | 'baixa' }>;
  hurdlePorEmpresa: Record<string, number>;
}): ProximaAcaoResult {
  const candidatos = [...input.candidatos];
  // benchmark sempre presente (o piso: se nada supera o hurdle, segura caixa / paga dívida / distribui)
  candidatos.push({ empresa: '—', descricao: 'Não fazer nada / pagar dívida / distribuir ao dono (benchmark do hurdle)', tipo: 'benchmark', impacto_eva: null, caixa_consumido: 0, payback_meses: null, spread_positivo: null, confianca: 'alta' });

  const fila: AcaoFila[] = candidatos.map((c) => {
    const hurdle = c.empresa in input.hurdlePorEmpresa ? input.hurdlePorEmpresa[c.empresa] : null;
    const caixaDisp = input.caixaPorEmpresa[c.empresa]?.disponivel ?? 0;
    // tem_dado: crescer precisa de hurdle + sinal de spread; consertar/liberar/benchmark sempre têm.
    const tem_dado = c.tipo === 'crescer' ? (hurdle != null && c.spread_positivo != null) : true;
    const status = classificarStatus({ tipo: c.tipo, impacto_eva: c.impacto_eva, spread_positivo: c.spread_positivo, caixa_consumido: c.caixa_consumido, caixa_disponivel: caixaDisp, hurdle, tem_dado });
    return { ...c, hurdle, status };
  });

  // Ordena: por prioridade de tipo; dentro do tipo, sem-caixa antes; depois EVA/caixa desc; payback asc.
  fila.sort((a, b) => {
    if (PRIORIDADE_TIPO[a.tipo] !== PRIORIDADE_TIPO[b.tipo]) return PRIORIDADE_TIPO[a.tipo] - PRIORIDADE_TIPO[b.tipo];
    const semCaixaA = (a.caixa_consumido ?? 0) === 0 ? 0 : 1;
    const semCaixaB = (b.caixa_consumido ?? 0) === 0 ? 0 : 1;
    if (semCaixaA !== semCaixaB) return semCaixaA - semCaixaB;
    const ratioA = a.caixa_consumido && a.caixa_consumido > 0 ? (a.impacto_eva ?? 0) / a.caixa_consumido : Infinity;
    const ratioB = b.caixa_consumido && b.caixa_consumido > 0 ? (b.impacto_eva ?? 0) / b.caixa_consumido : Infinity;
    if (ratioA !== ratioB) return ratioB - ratioA;
    return (a.payback_meses ?? Infinity) - (b.payback_meses ?? Infinity);
  });

  // Confiança da fila: pior sinal entre caixa/candidatos.
  const motivos: string[] = [];
  let nivel: 'alta' | 'media' | 'baixa' = 'alta';
  const rebaixa = (n: 'media' | 'baixa', m: string) => { if (n === 'baixa' || nivel === 'alta') nivel = n; motivos.push(m); };
  if (fila.some((a) => a.status === 'falta_dado')) rebaixa('media', 'Algumas ações sem hurdle/cockpit (Falta dado).');
  if (Object.values(input.caixaPorEmpresa).some((c) => c.confianca === 'baixa')) rebaixa('baixa', 'Projeção de caixa de alguma empresa com confiança baixa.');

  return { fila, caixa_por_empresa: input.caixaPorEmpresa, confianca: { nivel, motivos }, gerado_em: new Date().toISOString() };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- next-best-action-helpers`
Expected: PASS (toda a suíte do A4 verde).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/next-best-action-helpers.ts src/lib/financeiro/__tests__/next-best-action-helpers.test.ts
git commit -m "feat(financeiro a4): montarFilaAcoes (ordem por tipo/EVA-caixa, benchmark sempre, caixa por empresa)"
```

---

## Task 4: Engine `fin-next-best-action` (compõe A1/A2/A3)

**Files:**
- Create: `supabase/functions/fin-next-best-action/index.ts`

> Gate gestor+master (mesmo `authorizeGestorOuMaster` do `fin-valor-cockpit`). Helper espelhado verbatim. Chama as 3 functions via service_role (todas aceitam o SERVICE_ROLE como Bearer).

- [ ] **Step 1: Escrever a function**

```ts
// supabase/functions/fin-next-best-action/index.ts
// A4 — Próxima Melhor Ação. Gate gestor+master. Compõe A1/A2/A3 via service_role.
// Helper espelhado VERBATIM de src/lib/financeiro/next-best-action-helpers.ts.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function unauthorized(m = "Unauthorized"): Response { return jsonResponse({ error: m }, 401); }

async function authorizeGestorOuMaster(req: Request): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, response: unauthorized() };
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) return { ok: true };
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SERVICE_ROLE } });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };
    const roleRes = await fetch(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
    const roles = roleRes.ok ? (await roleRes.json()) as Array<{ role: string }> : [];
    if (roles.some((r) => r.role === "master")) return { ok: true };
    const comRes = await fetch(`${SUPABASE_URL}/rest/v1/commercial_roles?user_id=eq.${user.id}&select=commercial_role`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
    const com = comRes.ok ? (await comRes.json()) as Array<{ commercial_role: string }> : [];
    const gestor = new Set(["gerencial", "estrategico", "super_admin"]);
    if (com.some((c) => gestor.has(c.commercial_role))) return { ok: true };
    return { ok: false, response: unauthorized("Forbidden — gestor comercial ou master") };
  } catch { return { ok: false, response: unauthorized() }; }
}

// ===== Helper espelhado (verbatim de next-best-action-helpers.ts) =====
type StatusAcao = "financiar_ja" | "financiar_condicional" | "consertar_antes" | "falta_dado" | "nao_financiar";
type TipoAcao = "consertar_valor" | "liberar_caixa" | "crescer" | "benchmark";
function caixaDisponivel(input: { saldo_tesouraria: number; dias_cobertura: number; reserva_dias_min: number; confianca_baixa: boolean }): number {
  if (input.dias_cobertura <= 0) return 0;
  const fracaoReserva = Math.min(1, input.reserva_dias_min / input.dias_cobertura);
  let disp = input.saldo_tesouraria * (1 - fracaoReserva);
  if (input.confianca_baixa) disp *= 0.5;
  return Math.max(0, disp);
}
function classificarStatus(input: { tipo: TipoAcao; impacto_eva: number | null; spread_positivo: boolean | null; caixa_consumido: number | null; caixa_disponivel: number; hurdle: number | null; tem_dado: boolean }): StatusAcao {
  if (!input.tem_dado) return "falta_dado";
  if (input.tipo === "benchmark") return "nao_financiar";
  if (input.tipo === "consertar_valor" || input.tipo === "liberar_caixa") return "consertar_antes";
  if (input.tipo === "crescer") {
    if (input.spread_positivo !== true) return "nao_financiar";
    const custo = input.caixa_consumido ?? 0;
    return custo <= input.caixa_disponivel ? "financiar_ja" : "financiar_condicional";
  }
  return "falta_dado";
}
type AcaoCandidata = { empresa: string; descricao: string; tipo: TipoAcao; impacto_eva: number | null; caixa_consumido: number | null; payback_meses: number | null; spread_positivo: boolean | null; confianca: "alta" | "media" | "baixa" };
type AcaoFila = AcaoCandidata & { hurdle: number | null; status: StatusAcao };
const PRIORIDADE_TIPO: Record<TipoAcao, number> = { consertar_valor: 0, liberar_caixa: 1, crescer: 2, benchmark: 3 };
function montarFilaAcoes(input: { candidatos: AcaoCandidata[]; caixaPorEmpresa: Record<string, { disponivel: number; confianca: "alta" | "media" | "baixa" }>; hurdlePorEmpresa: Record<string, number> }) {
  const candidatos = [...input.candidatos];
  candidatos.push({ empresa: "—", descricao: "Não fazer nada / pagar dívida / distribuir ao dono (benchmark do hurdle)", tipo: "benchmark", impacto_eva: null, caixa_consumido: 0, payback_meses: null, spread_positivo: null, confianca: "alta" });
  const fila: AcaoFila[] = candidatos.map((c) => {
    const hurdle = c.empresa in input.hurdlePorEmpresa ? input.hurdlePorEmpresa[c.empresa] : null;
    const caixaDisp = input.caixaPorEmpresa[c.empresa]?.disponivel ?? 0;
    const tem_dado = c.tipo === "crescer" ? (hurdle != null && c.spread_positivo != null) : true;
    const status = classificarStatus({ tipo: c.tipo, impacto_eva: c.impacto_eva, spread_positivo: c.spread_positivo, caixa_consumido: c.caixa_consumido, caixa_disponivel: caixaDisp, hurdle, tem_dado });
    return { ...c, hurdle, status };
  });
  fila.sort((a, b) => {
    if (PRIORIDADE_TIPO[a.tipo] !== PRIORIDADE_TIPO[b.tipo]) return PRIORIDADE_TIPO[a.tipo] - PRIORIDADE_TIPO[b.tipo];
    const scA = (a.caixa_consumido ?? 0) === 0 ? 0 : 1; const scB = (b.caixa_consumido ?? 0) === 0 ? 0 : 1;
    if (scA !== scB) return scA - scB;
    const rA = a.caixa_consumido && a.caixa_consumido > 0 ? (a.impacto_eva ?? 0) / a.caixa_consumido : Infinity;
    const rB = b.caixa_consumido && b.caixa_consumido > 0 ? (b.impacto_eva ?? 0) / b.caixa_consumido : Infinity;
    if (rA !== rB) return rB - rA;
    return (a.payback_meses ?? Infinity) - (b.payback_meses ?? Infinity);
  });
  const motivos: string[] = []; let nivel: "alta" | "media" | "baixa" = "alta";
  const rebaixa = (n: "media" | "baixa", m: string) => { if (n === "baixa" || nivel === "alta") nivel = n; motivos.push(m); };
  if (fila.some((a) => a.status === "falta_dado")) rebaixa("media", "Algumas ações sem hurdle/cockpit (Falta dado).");
  if (Object.values(input.caixaPorEmpresa).some((c) => c.confianca === "baixa")) rebaixa("baixa", "Projeção de caixa de alguma empresa com confiança baixa.");
  return { fila, caixa_por_empresa: input.caixaPorEmpresa, confianca: { nivel, motivos }, gerado_em: new Date().toISOString() };
}

// ===== Orquestração: chama A1/A2/A3 via service_role =====
const EMPRESAS = ["oben", "colacor", "colacor_sc"];
const RESERVA_DIAS_MIN = 21; // ~3 semanas de cobertura como piso

async function invoke<T>(fn: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeGestorOuMaster(req);
  if (!auth.ok) return auth.response;

  const caixaPorEmpresa: Record<string, { disponivel: number; confianca: "alta" | "media" | "baixa" }> = {};
  const hurdlePorEmpresa: Record<string, number> = {};
  const candidatos: AcaoCandidata[] = [];

  // A1 (caixa) + A2 (hurdle/spread) por empresa
  for (const empresa of EMPRESAS) {
    const cash = await invoke<{ indicadores?: { dias_cobertura?: number; saldo_tesouraria?: number } }>("fin-cashflow-engine", { company: empresa });
    const dias = cash?.indicadores?.dias_cobertura ?? 0;
    const saldo = cash?.indicadores?.saldo_tesouraria ?? 0;
    const cashConfBaixa = cash == null; // engine falhou → trata como incerto
    caixaPorEmpresa[empresa] = {
      disponivel: caixaDisponivel({ saldo_tesouraria: saldo, dias_cobertura: dias, reserva_dias_min: RESERVA_DIAS_MIN, confianca_baixa: cashConfBaixa }),
      confianca: cashConfBaixa ? "baixa" : "alta",
    };

    const valor = await invoke<{ reportado?: { wacc?: number | null; spread?: number | null; roic_incremental?: number | null } }>("fin-valor-engine", { company: empresa });
    const wacc = valor?.reportado?.wacc ?? null;
    if (wacc != null) hurdlePorEmpresa[empresa] = wacc;
    // Sleeve company-level: cresce se spread positivo (A2). Confiança baixa (sem cockpit granular, exceto Oben).
    const spread = valor?.reportado?.spread ?? null;
    if (empresa !== "oben") {
      candidatos.push({
        empresa, descricao: `${empresa} — sleeve de crescimento (definir ação concreta: margem/NCG/payback)`,
        tipo: "crescer", impacto_eva: null, caixa_consumido: null, payback_meses: null,
        spread_positivo: spread != null ? spread > 0 : null, confianca: "baixa",
      });
    }
  }

  // A3 (Oben): recomendações de cliente viram ações concretas.
  const cockpit = await invoke<{ recomendacoesCliente?: Array<{ cliente: string; recomendacoes: Array<{ acao: string; motivo: string; impacto_rs: number | null }> }> }>("fin-valor-cockpit", {});
  for (const rc of cockpit?.recomendacoesCliente ?? []) {
    for (const rec of rc.recomendacoes) {
      const acaoLower = rec.acao.toLowerCase();
      const tipo: TipoAcao = acaoLower.includes("prazo") || acaoLower.includes("antecip") ? "liberar_caixa"
        : acaoLower.includes("crescer") ? "crescer"
        : "consertar_valor"; // cortar desconto / subir preço / despriorizar = consertar valor
      candidatos.push({
        empresa: "oben", descricao: `Oben — ${rec.acao} (cliente ${rc.cliente})`,
        tipo, impacto_eva: rec.impacto_rs, caixa_consumido: 0, payback_meses: null,
        spread_positivo: tipo === "crescer" ? true : null, confianca: "alta",
      });
    }
  }

  const result = montarFilaAcoes({ candidatos, caixaPorEmpresa, hurdlePorEmpresa });
  return jsonResponse(result, 200);
});
```

- [ ] **Step 2: `deno check`**

Run: `deno check supabase/functions/fin-next-best-action/index.ts`
Expected: sem erros novos. Cross-check: helper espelhado bate com `next-best-action-helpers.ts`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/fin-next-best-action/index.ts
git commit -m "feat(financeiro a4): edge function fin-next-best-action (compõe A1/A2/A3 via service_role; gestor+master)"
```

---

## Task 5: Tipos + hook `useProximaAcao`

**Files:**
- Modify: `src/services/financeiroService.ts`
- Create: `src/hooks/useProximaAcao.ts`

- [ ] **Step 1: Tipos no fim de `financeiroService.ts`**

```ts
// ═══════════════ A4 — Próxima Melhor Ação (contrato com fin-next-best-action) ═══════════════
export type StatusAcaoFila = 'financiar_ja' | 'financiar_condicional' | 'consertar_antes' | 'falta_dado' | 'nao_financiar';
export type TipoAcaoFila = 'consertar_valor' | 'liberar_caixa' | 'crescer' | 'benchmark';
export interface AcaoFila {
  empresa: string;
  descricao: string;
  tipo: TipoAcaoFila;
  impacto_eva: number | null;
  caixa_consumido: number | null;
  payback_meses: number | null;
  spread_positivo: boolean | null;
  confianca: 'alta' | 'media' | 'baixa';
  hurdle: number | null;
  status: StatusAcaoFila;
}
export interface ProximaAcaoResult {
  fila: AcaoFila[];
  caixa_por_empresa: Record<string, { disponivel: number; confianca: 'alta' | 'media' | 'baixa' }>;
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  gerado_em: string;
}
```

- [ ] **Step 2: Criar `src/hooks/useProximaAcao.ts`**

```ts
// src/hooks/useProximaAcao.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ProximaAcaoResult } from '@/services/financeiroService';

export function useProximaAcao(enabled = true) {
  return useQuery({
    queryKey: ['fin_proxima_acao'],
    enabled,
    queryFn: async (): Promise<ProximaAcaoResult> => {
      const { data, error } = await supabase.functions.invoke('fin-next-best-action', { body: {} });
      if (error) throw error;
      return data as ProximaAcaoResult;
    },
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: sem erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/services/financeiroService.ts src/hooks/useProximaAcao.ts
git commit -m "feat(financeiro a4): tipos do contrato + hook useProximaAcao"
```

---

## Task 6: Página + rota + sidebar (gestor+master)

**Files:**
- Create: `src/pages/FinanceiroProximaAcao.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Criar `src/pages/FinanceiroProximaAcao.tsx`**

```tsx
// src/pages/FinanceiroProximaAcao.tsx
import { useAuth } from '@/contexts/AuthContext';
import { useProximaAcao } from '@/hooks/useProximaAcao';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import type { AcaoFila, StatusAcaoFila } from '@/services/financeiroService';

const brl = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
const GRUPOS: { status: StatusAcaoFila; titulo: string; classe: string }[] = [
  { status: 'consertar_antes', titulo: 'Consertar antes (preço/prazo/caixa — faça primeiro)', classe: 'text-status-warning' },
  { status: 'financiar_ja', titulo: 'Financiar já', classe: 'text-status-success' },
  { status: 'financiar_condicional', titulo: 'Financiar condicional (sem caixa hoje)', classe: 'text-status-info' },
  { status: 'falta_dado', titulo: 'Falta dado (definir ação / hurdle)', classe: 'text-muted-foreground' },
  { status: 'nao_financiar', titulo: 'Não financiar / benchmark', classe: 'text-status-error' },
];

export default function FinanceiroProximaAcao() {
  const { isMaster, isGestorComercial } = useAuth();
  const podeVer = isMaster || isGestorComercial;
  const { data, isLoading, error } = useProximaAcao(podeVer);

  if (!podeVer) return <div className="p-6"><Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Acesso restrito — gestor comercial e master.</CardContent></Card></div>;
  if (isLoading) return <div className="p-6"><PageSkeleton variant="list" /></div>;
  if (error) return <div className="p-6"><Card><CardContent className="py-6 text-sm text-status-error">Erro: {error instanceof Error ? error.message : String(error)}</CardContent></Card></div>;
  if (!data) return null;

  const linha = (a: AcaoFila, i: number) => (
    <div key={i} className="flex justify-between gap-3 border-b border-border py-1 text-sm last:border-0">
      <span>{a.descricao}</span>
      <span className="font-mono whitespace-nowrap text-muted-foreground">
        {a.impacto_eva != null ? `EVA ${brl(a.impacto_eva)}/a` : ''} {a.caixa_consumido ? `· caixa ${brl(a.caixa_consumido)}` : ''}
      </span>
    </div>
  );

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div>
        <h1 className="font-display text-3xl">Próxima Melhor Ação</h1>
        <p className="text-sm text-muted-foreground">O que aprovar a seguir — e o que recusar — sob a restrição de caixa de cada empresa.</p>
      </div>
      {GRUPOS.map((g) => {
        const acoes = data.fila.filter((a) => a.status === g.status);
        if (acoes.length === 0) return null;
        return (
          <Card key={g.status}>
            <CardHeader><CardTitle className={`text-base ${g.classe}`}>{g.titulo}</CardTitle></CardHeader>
            <CardContent>{acoes.map(linha)}</CardContent>
          </Card>
        );
      })}
      <Card>
        <CardHeader><CardTitle className="text-base">Caixa disponível por empresa</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {Object.entries(data.caixa_por_empresa).map(([emp, c]) => (
            <div key={emp} className="flex justify-between border-b border-border py-1 last:border-0"><span>{emp}</span><span className="font-mono">{brl(c.disponivel)} <span className="text-muted-foreground">({c.confianca})</span></span></div>
          ))}
        </CardContent>
      </Card>
      {data.confianca.motivos.length > 0 && (
        <details className="text-xs text-muted-foreground"><summary>Confiança: {data.confianca.nivel}</summary><ul className="list-disc pl-4 mt-1">{data.confianca.motivos.map((m, i) => <li key={i}>{m}</li>)}</ul></details>
      )}
      <p className="text-xs text-muted-foreground">Caixa não é fungível entre as 3 empresas. Direcional; compõe A1 (caixa) + A2 (hurdle) + A3 (cockpit Oben).</p>
    </div>
  );
}
```

- [ ] **Step 2: Rota em `src/App.tsx`**

Lazy import junto aos `Financeiro*`:
```tsx
const FinanceiroProximaAcao = lazy(() => import("./pages/FinanceiroProximaAcao"));
```
Rota junto às `financeiro/*`:
```tsx
              <Route path="financeiro/proxima-acao" element={<FinanceiroProximaAcao />} />
```

- [ ] **Step 3: Link sidebar em `src/components/AppShell.tsx`**

Na seção Financeiro do `unifiedNavSections`, adicionar (segue o mesmo padrão `gestorComercialOuMaster` da A3 — o campo e os 3 filtros já existem):
```tsx
{ icon: ListChecks, label: 'Próxima Ação', path: '/financeiro/proxima-acao', gestorComercialOuMaster: true },
```
Importar `ListChecks` de `lucide-react` (adicionar ao import existente).

- [ ] **Step 4: Validar**

Run: `bunx tsc --noEmit && bun lint && bun run build`
Expected: PASS; zero lint novo.

- [ ] **Step 5: Commit**

```bash
git add src/pages/FinanceiroProximaAcao.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(financeiro a4): página /financeiro/proxima-acao (gestor+master) + rota + sidebar"
```

---

## Task 7: Docs + validação final + entregáveis

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md`

- [ ] **Step 1: Inserir seção A4 (após A3, antes de "MVP Operacional")**

```markdown
## 🔧 A4 — Próxima Melhor Ação (next-best-action) (2026-05-24)

Fila priorizada de ações concretas que o dono deve aprovar/recusar, sob a restrição de caixa de cada empresa. **Compõe** A1 (caixa) + A2 (hurdle/spread) + A3 (cockpit Oben) — não recomputa nada. Gate gestor comercial + master.

| Item | Como funciona |
|---|---|
| **Fila** | Ações ordenadas por tipo: consertar valor (A3 preço/prazo) → liberar caixa → crescer (A2 spread+) → benchmark. Dentro do tipo: sem-caixa primeiro, depois EVA/caixa, payback. |
| **Status** | Financiar já / Financiar condicional / Consertar antes / Falta dado / Não financiar. Hurdle (WACC A2) é o corte. |
| **Caixa** | Por empresa (NÃO fungível): saldo de tesouraria − reserva (dias de cobertura mínimos). Confiança baixa → haircut. |
| **Hurdle** | WACC da A2; fallback honesto (retorno do dono / custo de dívida / mediana) + flag se ausente. |
| **Benchmark** | "Não fazer nada / pagar dívida / distribuir" sempre presente — o piso quando nada supera o hurdle. |

**Regra de ouro:** consertar preço/prazo ANTES de crescer (não recomenda crescer quando a resposta é "parar de vender mal"). Caixa não-fungível entre PJs. Degrada honesto: function interna falha → ações daquela empresa viram "Falta dado". **Deferido:** otimização matemática; cockpit granular p/ Colacor/SC (só sleeve company-level até lá); execução automática (A4 recomenda, o dono decide).

**Onde:** helper `next-best-action-helpers.ts` (vitest); engine `fin-next-best-action` (gestor+master, chama A1/A2/A3 via service_role); página `/financeiro/proxima-acao`.
```

- [ ] **Step 2: Validação (suíte do CI)**

Run: `bun run test && bun run typecheck:strict && bunx tsc --noEmit && bun lint && bun run build`
Expected: tudo verde; zero lint novo. `deno check supabase/functions/fin-next-best-action/index.ts`.
Não-regressão: `git diff --stat $(git merge-base origin/main HEAD)..HEAD -- supabase/functions/fin-valor-engine supabase/functions/fin-valor-cockpit supabase/functions/fin-cashflow-engine` vazio (A4 não toca os anteriores).

- [ ] **Step 3: Commit + entregáveis**
```bash
git add docs/FINANCEIRO_CONFIABILIDADE.md
git commit -m "docs(financeiro a4): seção Próxima Melhor Ação em CONFIABILIDADE"
```
Entregar ao founder: prompt de deploy (criar `fin-next-best-action` lendo `supabase/functions/fin-next-best-action/index.ts` da main verbatim). Sem SQL obrigatório (opcional `retorno_minimo_dono` em `fin_config_cashflow` se quiser o fallback de hurdle do dono — entregar à parte).

- [ ] **Step 4: Finishing** — superpowers:finishing-a-development-branch (PR; admin-merge só se autorizado).

---

## Self-Review (autor do plano)

**Cobertura do spec:** fila priorizada → Task 3 ✅; status/hurdle como corte → Task 2 ✅; caixa por empresa não-fungível → Task 1 + montarFilaAcoes (caixaPorEmpresa keyed por empresa) ✅; hurdle fallback → Task 1 ✅; benchmark sempre presente → Task 3 ✅; composição A1/A2/A3 via service_role + gate → engine Task 4 ✅; A3 ausente p/ Colacor/SC → sleeve company-level confiança baixa (engine) ✅; degradação (function falha → Falta dado) → engine `invoke` retorna null + tem_dado false ✅; UI agrupada por status → Task 6 ✅; docs → Task 7 ✅.

**Placeholders:** Task 6 Step 3 (sidebar) reusa o padrão `gestorComercialOuMaster` JÁ existente (criado na A3) — só adiciona o item + importa `ListChecks`. Não é placeholder.

**Consistência de tipos:** `StatusAcao`/`TipoAcao`/`AcaoCandidata`/`AcaoFila`/`ProximaAcaoResult` batem entre helper (Tasks 1-3), engine (Task 4, espelhado) e serviço (Task 5: `AcaoFila`/`ProximaAcaoResult`). `gestorComercialOuMaster` consistente com A3. Hook `useProximaAcao(enabled)` consistente com `useValorCockpit(enabled)`.

**Atenção (execução):** (a) A2/A3 não deployadas → A4 ao vivo só depois do deploy delas; o engine degrada honesto enquanto isso. (b) `fin-cashflow-engine` body usa `company` (confirmado no contrato). (c) o mapeamento texto-da-recomendação→tipo (Task 4) é heurístico simples; ações de "subir preço/cortar desconto/despriorizar" caem em consertar_valor (correto). (d) `payback_meses` fica null (não computado) — ações de crescer ordenam por EVA/caixa; aceitável no MVP.
```
