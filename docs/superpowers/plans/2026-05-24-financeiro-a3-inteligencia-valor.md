# Financeiro A3 — Inteligência de Valor (Cockpit cliente/produto + preço/prazo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o Cockpit de Valor da Oben — ranking de clientes/SKUs/combos por **lucro econômico** (margem de contribuição − custo do capital de giro no hurdle-rate da A2) + recomendações de preço/prazo, com degradação honesta.

**Architecture:** Helper puro testável (`src/lib/financeiro/valor-cockpit-helpers.ts`, vitest) espelhado verbatim numa edge function Deno dedicada (`fin-valor-cockpit`, gate gestor+master) que lê `order_items` + `product_costs` + `inventory_position` + `fin_contas_receber` (Oben) + WACC(A2) e devolve a tabela atômica cliente×SKU com rollups que reconciliam. Frontend: hook `useValorCockpit` + página `/financeiro/valor-cockpit`.

**Tech Stack:** React 18 + TS + Vite + @tanstack/react-query + shadcn/ui + Tailwind (status-* tokens); Supabase Edge Function Deno + Postgres; vitest; `deno check`.

---

## Fonte da verdade

Spec aprovado: `docs/superpowers/specs/2026-05-24-financeiro-a3-inteligencia-valor-design.md`. Onde o plano divergir, vale o spec; mas as correções abaixo (descobertas no schema) sobrepõem o spec:

1. **Gate**: `commercial_role` é o enum `('operacional','gerencial','estrategico','super_admin')` — **não existe 'gestor'**. "Gestor comercial" = `commercial_role IN ('gerencial','estrategico','super_admin')`. Mais `user_roles.role='master'`.
2. **Join cliente→AR**: via `omie_clientes` (`user_id` → `omie_codigo_cliente`), não via `profiles`. `order_items.customer_user_id` = `omie_clientes.user_id`.
3. **Estoque**: `inventory_position` guarda só snapshot atual (sem histórico) → `I_s = saldo × cmc` atual, rotulado run-rate.
4. **Escopo MVP = Oben** (`omie_products.account`/inventory `account` = a conta da Oben; `fin_contas_receber.company='oben'`). Colacor/SC ficam fora deste plano.

## Estado da branch
Branch `feat/financeiro-a3-cockpit` criada de `origin/main`. O spec já está commitado (`9443448`). NÃO commitar sem o founder pedir além do já combinado (1 commit por task, sem push).

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/lib/financeiro/valor-cockpit-helpers.ts` | Funções puras: margem de contribuição, AR médio TTM, montagem da tabela atômica cliente×SKU + alocação + rollups, scores, recomendações, confiança. | Criar |
| `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts` | Testes vitest. | Criar |
| `supabase/functions/fin-valor-cockpit/index.ts` | Edge function Deno (gestor+master). Espelha o helper + lê DB (Oben) + WACC(A2). | Criar |
| `supabase/migrations/20260524000000_fin_a3_cockpit_config.sql` | Coluna JSONB opcional `fin_config_cashflow.cockpit_config`. | Criar |
| `src/services/financeiroService.ts` | Tipos `CockpitConfig`, `ValorCockpitResult`. | Modificar |
| `src/hooks/useValorCockpit.ts` | Hook react-query (invoca a function). | Criar |
| `src/pages/FinanceiroValorCockpit.tsx` | Página `/financeiro/valor-cockpit` (gate gestor+master): rankings + recomendações + confiança. | Criar |
| `src/App.tsx` | Lazy import + rota. | Modificar |
| `src/components/AppShell.tsx` | Link sidebar (gestor+master). | Modificar |
| `docs/FINANCEIRO_CONFIABILIDADE.md` | Seção A3. | Modificar |

---

## Contrato de tipos (referência única)

```ts
// ── inputs do helper ──
export type ComboInput = {
  cliente: string;            // omie_codigo_cliente (string) ou 'sem_cliente'
  sku: string;                // omie_codigo_produto (string)
  receita_liquida: number;    // Σ (unit_price*qty − discount) do combo no TTM
  quantidade: number;         // Σ qty
  custo_unitario: number | null; // product_costs.cost_price (null = ausente)
};
export type CapitalCliente = { cliente: string; ar_medio: number | null }; // A_c (null = não joinável)
export type CapitalSKU = { sku: string; estoque_valor: number | null };    // I_s (null = sem estoque/cmc)

// ── saídas ──
export type CelulaEVP = {
  cliente: string; sku: string; receita_liquida: number; quantidade: number;
  cm: number | null; a_cs: number; i_cs: number; encargo: number; evp: number | null;
  ar_indisponivel: boolean; estoque_indisponivel: boolean;
};
export type RollupCliente = { cliente: string; receita: number; cm: number | null; encargo: number; evp: number | null };
export type RollupSKU = { sku: string; receita: number; quantidade: number; cm: number | null; encargo: number; evp: number | null };
export type ComboEVPResult = {
  celulas: CelulaEVP[];
  porCliente: RollupCliente[];
  porSKU: RollupSKU[];
  empresa: { receita: number; cm: number | null; encargo: number; evp: number | null };
};

export type CockpitConfig = {
  margem_minima_pct: number;     // ex 0.15
  desconto_max_pct: number;      // ex 0.10
  prazo_alvo_dias: number;       // ex 30
  dias_estoque_max: number;      // ex 120
  sample_min_receita: number;    // ex 5000
};
export type Recomendacao = { acao: string; motivo: string; impacto_rs: number | null };
```

Regras de null/reconciliação:
- `cm = null` quando `custo_unitario = null`. Células com `cm = null` ficam FORA dos rollups de EVP (mostradas à parte).
- `a_cs`/`i_cs`: se a base do cliente/SKU é null (não joinável / sem estoque), o componente vira `0` e marca o flag (`ar_indisponivel`/`estoque_indisponivel`) — preserva a aditividade dos rollups; a confiança degrada via % de flags.
- Invariante (em dataset completo): `Σ evp(porCliente) = Σ evp(porSKU) = Σ evp(células com cm≠null) = empresa.evp`.

---

## Task 0: Confirmar branch + spec

- [ ] **Step 1: Confirmar branch e spec**

```bash
git branch --show-current   # feat/financeiro-a3-cockpit
test -f docs/superpowers/specs/2026-05-24-financeiro-a3-inteligencia-valor-design.md && echo "spec OK"
test -d node_modules || bun install
```

---

## Task 1: `margemContribuicao` + `arMedioTTM`

**Files:**
- Create: `src/lib/financeiro/valor-cockpit-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

```ts
// src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { margemContribuicao, arMedioTTM } from '../valor-cockpit-helpers';

describe('margemContribuicao', () => {
  it('receita − custo×qtd', () => {
    expect(margemContribuicao({ receita_liquida: 1000, custo_unitario: 6, quantidade: 100 })).toBe(400);
  });
  it('custo ausente → null', () => {
    expect(margemContribuicao({ receita_liquida: 1000, custo_unitario: null, quantidade: 100 })).toBeNull();
  });
  it('margem negativa é honesta (vende abaixo do custo)', () => {
    expect(margemContribuicao({ receita_liquida: 500, custo_unitario: 6, quantidade: 100 })).toBe(-100);
  });
});

describe('arMedioTTM', () => {
  const win = { ttm_inicio: '2025-06-01', ttm_fim: '2026-06-01' }; // 365 dias
  it('título aberto a janela inteira: média ≈ saldo', () => {
    const a = arMedioTTM({
      titulos: [{ valor_documento: 1000, saldo: 1000, data_emissao: '2025-06-01', data_recebimento: null, status: 'ABERTO' }],
      ...win,
    });
    expect(a).toBeCloseTo(1000, 0);
  });
  it('título recebido na metade: contribui metade do tempo', () => {
    const a = arMedioTTM({
      titulos: [{ valor_documento: 1000, saldo: 0, data_emissao: '2025-06-01', data_recebimento: '2025-12-01', status: 'RECEBIDO' }],
      ...win,
    });
    // ~183 dias aberto / 365 × 1000 ≈ 501
    expect(a).toBeGreaterThan(450);
    expect(a).toBeLessThan(550);
  });
  it('sem data_emissao → ignora o título', () => {
    expect(arMedioTTM({ titulos: [{ valor_documento: 9999, saldo: 9999, data_emissao: null, data_recebimento: null, status: 'ABERTO' }], ...win })).toBe(0);
  });
  it('sem títulos → 0', () => {
    expect(arMedioTTM({ titulos: [], ...win })).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-cockpit-helpers`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementação**

```ts
// src/lib/financeiro/valor-cockpit-helpers.ts
// A3 — Inteligência de Valor (Cockpit cliente/produto). Módulo puro, espelhado verbatim
// na edge function Deno supabase/functions/fin-valor-cockpit/index.ts.

export function margemContribuicao(input: { receita_liquida: number; custo_unitario: number | null; quantidade: number }): number | null {
  if (input.custo_unitario == null || !Number.isFinite(input.custo_unitario)) return null;
  return input.receita_liquida - input.custo_unitario * input.quantidade;
}

function diasEntre(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
}
function maxData(a: string, b: string): string { return a >= b ? a : b; }
function minData(a: string, b: string): string { return a <= b ? a : b; }

export type TituloAR = {
  valor_documento: number; saldo: number;
  data_emissao: string | null; data_recebimento: string | null; status: string;
};

// Saldo médio em aberto (time-weighted) na janela [ttm_inicio, ttm_fim).
// Aproximação documentada: título recebido contribui `valor_documento` de emissão→recebimento;
// título em aberto contribui `saldo` de emissão→fim. Ignora cronologia de pagamentos parciais.
export function arMedioTTM(input: { titulos: TituloAR[]; ttm_inicio: string; ttm_fim: string }): number {
  const janelaDias = diasEntre(input.ttm_inicio, input.ttm_fim);
  if (janelaDias <= 0) return 0;
  let soma = 0;
  for (const t of input.titulos) {
    if (!t.data_emissao) continue;
    const inicioOpen = maxData(t.data_emissao, input.ttm_inicio);
    const fimOpen = t.data_recebimento ? minData(t.data_recebimento, input.ttm_fim) : input.ttm_fim;
    const dias = diasEntre(inicioOpen, fimOpen);
    if (dias <= 0) continue;
    const valor = t.data_recebimento ? t.valor_documento : t.saldo;
    soma += valor * dias;
  }
  return soma / janelaDias;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-cockpit-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(financeiro a3): margemContribuicao + arMedioTTM (saldo médio TTM time-weighted)"
```

---

## Task 2: `montarCelulasComboEVP` + rollups (núcleo)

**Files:**
- Modify: `src/lib/financeiro/valor-cockpit-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`

- [ ] **Step 1: Adicionar os testes que falham**

```ts
import { montarCelulasComboEVP } from '../valor-cockpit-helpers';

describe('montarCelulasComboEVP', () => {
  const base = {
    combos: [
      { cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }, // cm 400
      { cliente: 'C1', sku: 'S2', receita_liquida: 1000, quantidade: 50, custo_unitario: 10 },  // cm 500
      { cliente: 'C2', sku: 'S1', receita_liquida: 2000, quantidade: 100, custo_unitario: 6 },  // cm 1400
    ],
    capitalClientes: [{ cliente: 'C1', ar_medio: 600 }, { cliente: 'C2', ar_medio: 1000 }],
    capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }, { sku: 'S2', estoque_valor: 400 }],
    k: 0.20,
  };

  it('aloca AR por receita do cliente e estoque por quantidade do SKU', () => {
    const r = montarCelulasComboEVP(base);
    const c1s1 = r.celulas.find((c) => c.cliente === 'C1' && c.sku === 'S1')!;
    // R_C1 = 2000 → a_cs = 600 × 1000/2000 = 300
    expect(c1s1.a_cs).toBeCloseTo(300, 6);
    // Q_S1 = 200 (C1 100 + C2 100) → i_cs = 800 × 100/200 = 400
    expect(c1s1.i_cs).toBeCloseTo(400, 6);
    // encargo = 0.20 × (300+400) = 140 ; evp = 400 − 140 = 260
    expect(c1s1.encargo).toBeCloseTo(140, 6);
    expect(c1s1.evp).toBeCloseTo(260, 6);
  });

  it('INVARIANTE: Σ porCliente.evp = Σ porSKU.evp = empresa.evp', () => {
    const r = montarCelulasComboEVP(base);
    const somaCli = r.porCliente.reduce((s, x) => s + (x.evp ?? 0), 0);
    const somaSku = r.porSKU.reduce((s, x) => s + (x.evp ?? 0), 0);
    expect(somaCli).toBeCloseTo(r.empresa.evp!, 6);
    expect(somaSku).toBeCloseTo(r.empresa.evp!, 6);
    expect(somaCli).toBeCloseTo(somaSku, 6);
  });

  it('custo ausente → cm null, célula fora do EVP, flag', () => {
    const r = montarCelulasComboEVP({
      ...base,
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: null }],
    });
    expect(r.celulas[0].cm).toBeNull();
    expect(r.celulas[0].evp).toBeNull();
    expect(r.empresa.cm).toBeNull(); // nenhum cm válido
  });

  it('AR do cliente null → a_cs 0 + flag ar_indisponivel', () => {
    const r = montarCelulasComboEVP({
      ...base,
      capitalClientes: [{ cliente: 'C1', ar_medio: null }, { cliente: 'C2', ar_medio: 1000 }],
    });
    const c1 = r.celulas.find((c) => c.cliente === 'C1')!;
    expect(c1.a_cs).toBe(0);
    expect(c1.ar_indisponivel).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-cockpit-helpers`
Expected: FAIL — `montarCelulasComboEVP is not a function`.

- [ ] **Step 3: Implementação (append)**

```ts
export type ComboInput = { cliente: string; sku: string; receita_liquida: number; quantidade: number; custo_unitario: number | null };
export type CapitalCliente = { cliente: string; ar_medio: number | null };
export type CapitalSKU = { sku: string; estoque_valor: number | null };
export type CelulaEVP = {
  cliente: string; sku: string; receita_liquida: number; quantidade: number;
  cm: number | null; a_cs: number; i_cs: number; encargo: number; evp: number | null;
  ar_indisponivel: boolean; estoque_indisponivel: boolean;
};
export type RollupCliente = { cliente: string; receita: number; cm: number | null; encargo: number; evp: number | null };
export type RollupSKU = { sku: string; receita: number; quantidade: number; cm: number | null; encargo: number; evp: number | null };
export type ComboEVPResult = {
  celulas: CelulaEVP[];
  porCliente: RollupCliente[];
  porSKU: RollupSKU[];
  empresa: { receita: number; cm: number | null; encargo: number; evp: number | null };
};

export function montarCelulasComboEVP(input: {
  combos: ComboInput[];
  capitalClientes: CapitalCliente[];
  capitalSKUs: CapitalSKU[];
  k: number;
}): ComboEVPResult {
  const arPorCliente = new Map(input.capitalClientes.map((c) => [c.cliente, c.ar_medio]));
  const estoquePorSKU = new Map(input.capitalSKUs.map((s) => [s.sku, s.estoque_valor]));
  // totais pra alocação
  const receitaPorCliente = new Map<string, number>();
  const qtdPorSKU = new Map<string, number>();
  for (const c of input.combos) {
    receitaPorCliente.set(c.cliente, (receitaPorCliente.get(c.cliente) ?? 0) + c.receita_liquida);
    qtdPorSKU.set(c.sku, (qtdPorSKU.get(c.sku) ?? 0) + c.quantidade);
  }

  const celulas: CelulaEVP[] = input.combos.map((c) => {
    const cm = margemContribuicao({ receita_liquida: c.receita_liquida, custo_unitario: c.custo_unitario, quantidade: c.quantidade });
    const arC = arPorCliente.get(c.cliente) ?? null;
    const estS = estoquePorSKU.get(c.sku) ?? null;
    const rc = receitaPorCliente.get(c.cliente) ?? 0;
    const qs = qtdPorSKU.get(c.sku) ?? 0;
    const ar_indisponivel = arC == null;
    const estoque_indisponivel = estS == null;
    const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;
    const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;
    const encargo = input.k * (a_cs + i_cs);
    const evp = cm == null ? null : cm - encargo;
    return { cliente: c.cliente, sku: c.sku, receita_liquida: c.receita_liquida, quantidade: c.quantidade, cm, a_cs, i_cs, encargo, evp, ar_indisponivel, estoque_indisponivel };
  });

  const rollup = <K extends string>(keyFn: (c: CelulaEVP) => string) => {
    const m = new Map<string, { receita: number; quantidade: number; cm: number; cmNull: boolean; encargo: number; evp: number; evpNull: boolean }>();
    for (const cel of celulas) {
      const key = keyFn(cel);
      const acc = m.get(key) ?? { receita: 0, quantidade: 0, cm: 0, cmNull: true, encargo: 0, evp: 0, evpNull: true };
      acc.receita += cel.receita_liquida;
      acc.quantidade += cel.quantidade;
      if (cel.cm != null) { acc.cm += cel.cm; acc.cmNull = false; }
      acc.encargo += cel.encargo;
      if (cel.evp != null) { acc.evp += cel.evp; acc.evpNull = false; }
      m.set(key, acc);
    }
    return m;
  };

  const mc = rollup((c) => c.cliente);
  const ms = rollup((c) => c.sku);
  const porCliente: RollupCliente[] = [...mc.entries()].map(([cliente, a]) => ({ cliente, receita: a.receita, cm: a.cmNull ? null : a.cm, encargo: a.encargo, evp: a.evpNull ? null : a.evp }));
  const porSKU: RollupSKU[] = [...ms.entries()].map(([sku, a]) => ({ sku, receita: a.receita, quantidade: a.quantidade, cm: a.cmNull ? null : a.cm, encargo: a.encargo, evp: a.evpNull ? null : a.evp }));

  let cmEmp = 0, cmNull = true, encEmp = 0, evpEmp = 0, evpNull = true, recEmp = 0;
  for (const cel of celulas) {
    recEmp += cel.receita_liquida;
    encEmp += cel.encargo;
    if (cel.cm != null) { cmEmp += cel.cm; cmNull = false; }
    if (cel.evp != null) { evpEmp += cel.evp; evpNull = false; }
  }
  return { celulas, porCliente, porSKU, empresa: { receita: recEmp, cm: cmNull ? null : cmEmp, encargo: encEmp, evp: evpNull ? null : evpEmp } };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-cockpit-helpers`
Expected: PASS (invariante de reconciliação verde).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(financeiro a3): montarCelulasComboEVP — tabela atômica cliente×SKU + rollups que reconciliam"
```

---

## Task 3: `recomendarAcaoComercial`

**Files:**
- Modify: `src/lib/financeiro/valor-cockpit-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`

- [ ] **Step 1: Adicionar os testes que falham**

```ts
import { recomendarAcaoComercial } from '../valor-cockpit-helpers';

const cfg = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };

describe('recomendarAcaoComercial', () => {
  it('desconto acima do máx + EVP baixo → cortar desconto', () => {
    const r = recomendarAcaoComercial({ evp: -50, receita_liquida: 1000, cm: 100, desconto_total: 200, prazo_medio_dias: 20, dias_estoque: 30, config: cfg });
    expect(r.some((x) => x.acao.toLowerCase().includes('desconto'))).toBe(true);
  });
  it('prazo acima do alvo + encargo de AR pesado → encurtar prazo', () => {
    const r = recomendarAcaoComercial({ evp: -10, receita_liquida: 1000, cm: 100, desconto_total: 0, prazo_medio_dias: 75, dias_estoque: 30, config: cfg });
    expect(r.some((x) => x.acao.toLowerCase().includes('prazo'))).toBe(true);
  });
  it('margem% abaixo da mínima → subir preço com impacto R$', () => {
    const r = recomendarAcaoComercial({ evp: 5, receita_liquida: 1000, cm: 80, desconto_total: 0, prazo_medio_dias: 20, dias_estoque: 30, config: cfg });
    const subir = r.find((x) => x.acao.toLowerCase().includes('preço'));
    expect(subir).toBeTruthy();
    expect(subir!.impacto_rs).not.toBeNull();
  });
  it('estoque acima do limite + EVP negativo → despriorizar/liquidar SKU', () => {
    const r = recomendarAcaoComercial({ evp: -100, receita_liquida: 1000, cm: 100, desconto_total: 0, prazo_medio_dias: 20, dias_estoque: 200, config: cfg });
    expect(r.some((x) => x.acao.toLowerCase().includes('estoque') || x.acao.toLowerCase().includes('despriorizar'))).toBe(true);
  });
  it('tudo saudável → recomenda crescer/proteger', () => {
    const r = recomendarAcaoComercial({ evp: 300, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 15, dias_estoque: 30, config: cfg });
    expect(r.some((x) => x.acao.toLowerCase().includes('crescer'))).toBe(true);
  });
  it('cm null → sem recomendação de preço (sem dado)', () => {
    const r = recomendarAcaoComercial({ evp: null, receita_liquida: 1000, cm: null, desconto_total: 0, prazo_medio_dias: 15, dias_estoque: 30, config: cfg });
    expect(r.every((x) => !x.acao.toLowerCase().includes('preço'))).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-cockpit-helpers`
Expected: FAIL — `recomendarAcaoComercial is not a function`.

- [ ] **Step 3: Implementação (append)**

```ts
export type CockpitConfig = {
  margem_minima_pct: number;
  desconto_max_pct: number;
  prazo_alvo_dias: number;
  dias_estoque_max: number;
  sample_min_receita: number;
};
export type Recomendacao = { acao: string; motivo: string; impacto_rs: number | null };

export function recomendarAcaoComercial(input: {
  evp: number | null;
  receita_liquida: number;
  cm: number | null;
  desconto_total: number;
  prazo_medio_dias: number;
  dias_estoque: number;
  config: CockpitConfig;
}): Recomendacao[] {
  const r: Recomendacao[] = [];
  const c = input.config;
  const receitaBruta = input.receita_liquida + input.desconto_total;
  const descontoPct = receitaBruta > 0 ? input.desconto_total / receitaBruta : 0;
  const cmPct = input.cm != null && input.receita_liquida > 0 ? input.cm / input.receita_liquida : null;

  // cortar desconto: desconto acima do máx e valor não justifica (EVP baixo/negativo)
  if (descontoPct > c.desconto_max_pct && (input.evp == null || input.evp <= 0)) {
    const recupera = input.desconto_total - receitaBruta * c.desconto_max_pct;
    r.push({ acao: 'Cortar desconto', motivo: `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% e o combo não gera valor.`, impacto_rs: Math.max(0, recupera) });
  }
  // encurtar prazo: prazo acima do alvo e EVP negativo
  if (input.prazo_medio_dias > c.prazo_alvo_dias && (input.evp == null || input.evp < 0)) {
    r.push({ acao: 'Encurtar prazo / exigir antecipado', motivo: `Prazo médio ${input.prazo_medio_dias.toFixed(0)}d > alvo ${c.prazo_alvo_dias}d puxa o custo de capital de giro.`, impacto_rs: null });
  }
  // subir preço: margem% abaixo da mínima
  if (cmPct != null && cmPct < c.margem_minima_pct) {
    const alvoCM = c.margem_minima_pct * input.receita_liquida;
    r.push({ acao: 'Subir preço', motivo: `Margem ${(cmPct * 100).toFixed(0)}% < mínima ${(c.margem_minima_pct * 100).toFixed(0)}%.`, impacto_rs: Math.max(0, alvoCM - (input.cm as number)) });
  }
  // despriorizar/liquidar SKU: estoque alto + EVP negativo
  if (input.dias_estoque > c.dias_estoque_max && (input.evp == null || input.evp < 0)) {
    r.push({ acao: 'Despriorizar / liquidar estoque', motivo: `${input.dias_estoque.toFixed(0)} dias de estoque > limite ${c.dias_estoque_max}d e o item não gera valor.`, impacto_rs: null });
  }
  // crescer: EVP positivo e nada disparou
  if (r.length === 0 && input.evp != null && input.evp > 0) {
    r.push({ acao: 'Crescer / proteger', motivo: 'Gera valor econômico positivo e sem alertas.', impacto_rs: null });
  }
  return r;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-cockpit-helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(financeiro a3): recomendarAcaoComercial (regras preço/prazo/desconto/estoque com R$ em jogo)"
```

---

## Task 4: `scoreConfiancaCockpit`

**Files:**
- Modify: `src/lib/financeiro/valor-cockpit-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`

- [ ] **Step 1: Adicionar os testes que falham**

```ts
import { scoreConfiancaCockpit } from '../valor-cockpit-helpers';

describe('scoreConfiancaCockpit', () => {
  it('tudo coberto → alta', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false });
    expect(r.nivel).toBe('alta');
  });
  it('cobertura de receita baixa → rebaixa + motivo', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.4, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false });
    expect(r.nivel).not.toBe('alta');
    expect(r.motivos.some((m) => m.toLowerCase().includes('cobertura'))).toBe(true);
  });
  it('muito custo ausente → baixa', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0.6, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false });
    expect(r.nivel).toBe('baixa');
  });
  it('imposto estimado vira motivo (não derruba sozinho)', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: true });
    expect(r.motivos.some((m) => m.toLowerCase().includes('imposto'))).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- valor-cockpit-helpers`
Expected: FAIL — `scoreConfiancaCockpit is not a function`.

- [ ] **Step 3: Implementação (append)**

```ts
export type ConfiancaCockpit = { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };

export function scoreConfiancaCockpit(input: {
  cobertura_receita: number;     // [0,1] receita order_items ÷ receita-AR do período
  custo_ausente_pct: number;     // [0,1] células sem custo
  ar_indisponivel_pct: number;   // [0,1] células sem AR joinável
  estoque_ausente_pct: number;   // [0,1] SKUs sem estoque/cmc
  imposto_estimado: boolean;
}): ConfiancaCockpit {
  const motivos: string[] = [];
  let nivel = 3; // 3 alta, 2 media, 1 baixa
  const rebaixar = (para: number, m: string) => { if (para < nivel) nivel = para; motivos.push(m); };

  if (input.cobertura_receita < 0.6) rebaixar(1, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% — muita venda fora do app; cockpit parcial.`);
  else if (input.cobertura_receita < 0.85) rebaixar(2, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% (ideal ≥85%).`);

  if (input.custo_ausente_pct > 0.4) rebaixar(1, `${(input.custo_ausente_pct * 100).toFixed(0)}% das células sem custo — margem indisponível em boa parte.`);
  else if (input.custo_ausente_pct > 0.15) rebaixar(2, `${(input.custo_ausente_pct * 100).toFixed(0)}% sem custo cadastrado.`);

  if (input.ar_indisponivel_pct > 0.3) rebaixar(2, `${(input.ar_indisponivel_pct * 100).toFixed(0)}% das vendas sem AR vinculável — encargo de cliente subestimado.`);
  if (input.estoque_ausente_pct > 0.3) rebaixar(2, `${(input.estoque_ausente_pct * 100).toFixed(0)}% dos SKUs sem estoque — encargo de SKU subestimado.`);
  if (input.imposto_estimado) motivos.push('Imposto alocado nível-empresa (estimado), não por linha.');

  return { nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa', motivos };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- valor-cockpit-helpers`
Expected: PASS (suite inteira do A3 verde).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(financeiro a3): scoreConfiancaCockpit (cobertura/custo/ar/estoque/imposto)"
```

---

## Task 5: SQL — coluna `cockpit_config`

**Files:**
- Create: `supabase/migrations/20260524000000_fin_a3_cockpit_config.sql`

- [ ] **Step 1: Criar a migration**

```sql
-- supabase/migrations/20260524000000_fin_a3_cockpit_config.sql
-- A3 — Cockpit de Valor: limiares operacionais (política comercial, NÃO dado do dono).
-- Coluna OPCIONAL em fin_config_cashflow (legível por staff/gestor é OK). Engine lê defensivo.

ALTER TABLE fin_config_cashflow
  ADD COLUMN IF NOT EXISTS cockpit_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN fin_config_cashflow.cockpit_config IS
  'A3: { margem_minima_pct, desconto_max_pct, prazo_alvo_dias, dias_estoque_max, sample_min_receita }';

SELECT 'A3 cockpit_config OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name='fin_config_cashflow' AND column_name='cockpit_config') AS coluna_existe;
```

- [ ] **Step 2: Regenerar audit**

Run: `bun run audit:migrations`
Expected: roda sem erro; nova migration entra no inventário.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260524000000_fin_a3_cockpit_config.sql docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "feat(financeiro a3): migration cockpit_config (coluna JSONB opcional)"
```

---

## Task 6: Edge function `fin-valor-cockpit`

**Files:**
- Create: `supabase/functions/fin-valor-cockpit/index.ts`

> Gate gestor+master. Boilerplate de auth do `fin-cashflow-engine` (CORS/jsonResponse/unauthorized). Helpers copiados VERBATIM de `valor-cockpit-helpers.ts`. Escopo Oben.

- [ ] **Step 1: Escrever a function**

```ts
// supabase/functions/fin-valor-cockpit/index.ts
// A3 — Cockpit de Valor (Oben). Gate: master OU commercial_role gerencial/estrategico/super_admin.
// Helpers espelhados VERBATIM de src/lib/financeiro/valor-cockpit-helpers.ts.
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
function unauthorized(m = "Unauthorized"): Response { return jsonResponse({ error: m }, 401); }

// Gate: master (user_roles) OU gestor comercial (commercial_roles gerencial/estrategico/super_admin).
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

// ===== Helpers espelhados (verbatim de valor-cockpit-helpers.ts) =====
function margemContribuicao(input: { receita_liquida: number; custo_unitario: number | null; quantidade: number }): number | null {
  if (input.custo_unitario == null || !Number.isFinite(input.custo_unitario)) return null;
  return input.receita_liquida - input.custo_unitario * input.quantidade;
}
function diasEntre(a: string, b: string): number { return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000); }
function maxData(a: string, b: string): string { return a >= b ? a : b; }
function minData(a: string, b: string): string { return a <= b ? a : b; }
type TituloAR = { valor_documento: number; saldo: number; data_emissao: string | null; data_recebimento: string | null; status: string };
function arMedioTTM(input: { titulos: TituloAR[]; ttm_inicio: string; ttm_fim: string }): number {
  const janelaDias = diasEntre(input.ttm_inicio, input.ttm_fim);
  if (janelaDias <= 0) return 0;
  let soma = 0;
  for (const t of input.titulos) {
    if (!t.data_emissao) continue;
    const inicioOpen = maxData(t.data_emissao, input.ttm_inicio);
    const fimOpen = t.data_recebimento ? minData(t.data_recebimento, input.ttm_fim) : input.ttm_fim;
    const dias = diasEntre(inicioOpen, fimOpen);
    if (dias <= 0) continue;
    soma += (t.data_recebimento ? t.valor_documento : t.saldo) * dias;
  }
  return soma / janelaDias;
}
type ComboInput = { cliente: string; sku: string; receita_liquida: number; quantidade: number; custo_unitario: number | null };
type CapitalCliente = { cliente: string; ar_medio: number | null };
type CapitalSKU = { sku: string; estoque_valor: number | null };
function montarCelulasComboEVP(input: { combos: ComboInput[]; capitalClientes: CapitalCliente[]; capitalSKUs: CapitalSKU[]; k: number }) {
  const arPorCliente = new Map(input.capitalClientes.map((c) => [c.cliente, c.ar_medio]));
  const estoquePorSKU = new Map(input.capitalSKUs.map((s) => [s.sku, s.estoque_valor]));
  const receitaPorCliente = new Map<string, number>();
  const qtdPorSKU = new Map<string, number>();
  for (const c of input.combos) {
    receitaPorCliente.set(c.cliente, (receitaPorCliente.get(c.cliente) ?? 0) + c.receita_liquida);
    qtdPorSKU.set(c.sku, (qtdPorSKU.get(c.sku) ?? 0) + c.quantidade);
  }
  const celulas = input.combos.map((c) => {
    const cm = margemContribuicao({ receita_liquida: c.receita_liquida, custo_unitario: c.custo_unitario, quantidade: c.quantidade });
    const arC = arPorCliente.get(c.cliente) ?? null;
    const estS = estoquePorSKU.get(c.sku) ?? null;
    const rc = receitaPorCliente.get(c.cliente) ?? 0;
    const qs = qtdPorSKU.get(c.sku) ?? 0;
    const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;
    const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;
    const encargo = input.k * (a_cs + i_cs);
    const evp = cm == null ? null : cm - encargo;
    return { cliente: c.cliente, sku: c.sku, receita_liquida: c.receita_liquida, quantidade: c.quantidade, cm, a_cs, i_cs, encargo, evp, ar_indisponivel: arC == null, estoque_indisponivel: estS == null };
  });
  type Cel = typeof celulas[number];
  const rollup = (keyFn: (c: Cel) => string) => {
    const m = new Map<string, { receita: number; quantidade: number; cm: number; cmNull: boolean; encargo: number; evp: number; evpNull: boolean }>();
    for (const cel of celulas) {
      const key = keyFn(cel);
      const acc = m.get(key) ?? { receita: 0, quantidade: 0, cm: 0, cmNull: true, encargo: 0, evp: 0, evpNull: true };
      acc.receita += cel.receita_liquida; acc.quantidade += cel.quantidade;
      if (cel.cm != null) { acc.cm += cel.cm; acc.cmNull = false; }
      acc.encargo += cel.encargo;
      if (cel.evp != null) { acc.evp += cel.evp; acc.evpNull = false; }
      m.set(key, acc);
    }
    return m;
  };
  const mc = rollup((c) => c.cliente);
  const ms = rollup((c) => c.sku);
  const porCliente = [...mc.entries()].map(([cliente, a]) => ({ cliente, receita: a.receita, cm: a.cmNull ? null : a.cm, encargo: a.encargo, evp: a.evpNull ? null : a.evp }));
  const porSKU = [...ms.entries()].map(([sku, a]) => ({ sku, receita: a.receita, quantidade: a.quantidade, cm: a.cmNull ? null : a.cm, encargo: a.encargo, evp: a.evpNull ? null : a.evp }));
  let cmEmp = 0, cmNull = true, encEmp = 0, evpEmp = 0, evpNull = true, recEmp = 0;
  for (const cel of celulas) { recEmp += cel.receita_liquida; encEmp += cel.encargo; if (cel.cm != null) { cmEmp += cel.cm; cmNull = false; } if (cel.evp != null) { evpEmp += cel.evp; evpNull = false; } }
  return { celulas, porCliente, porSKU, empresa: { receita: recEmp, cm: cmNull ? null : cmEmp, encargo: encEmp, evp: evpNull ? null : evpEmp } };
}
type CockpitConfig = { margem_minima_pct: number; desconto_max_pct: number; prazo_alvo_dias: number; dias_estoque_max: number; sample_min_receita: number };
type Recomendacao = { acao: string; motivo: string; impacto_rs: number | null };
function recomendarAcaoComercial(input: { evp: number | null; receita_liquida: number; cm: number | null; desconto_total: number; prazo_medio_dias: number; dias_estoque: number; config: CockpitConfig }): Recomendacao[] {
  const r: Recomendacao[] = []; const c = input.config;
  const receitaBruta = input.receita_liquida + input.desconto_total;
  const descontoPct = receitaBruta > 0 ? input.desconto_total / receitaBruta : 0;
  const cmPct = input.cm != null && input.receita_liquida > 0 ? input.cm / input.receita_liquida : null;
  if (descontoPct > c.desconto_max_pct && (input.evp == null || input.evp <= 0)) r.push({ acao: "Cortar desconto", motivo: `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% e o combo não gera valor.`, impacto_rs: Math.max(0, input.desconto_total - receitaBruta * c.desconto_max_pct) });
  if (input.prazo_medio_dias > c.prazo_alvo_dias && (input.evp == null || input.evp < 0)) r.push({ acao: "Encurtar prazo / exigir antecipado", motivo: `Prazo médio ${input.prazo_medio_dias.toFixed(0)}d > alvo ${c.prazo_alvo_dias}d puxa o custo de capital de giro.`, impacto_rs: null });
  if (cmPct != null && cmPct < c.margem_minima_pct) r.push({ acao: "Subir preço", motivo: `Margem ${(cmPct * 100).toFixed(0)}% < mínima ${(c.margem_minima_pct * 100).toFixed(0)}%.`, impacto_rs: Math.max(0, c.margem_minima_pct * input.receita_liquida - (input.cm as number)) });
  if (input.dias_estoque > c.dias_estoque_max && (input.evp == null || input.evp < 0)) r.push({ acao: "Despriorizar / liquidar estoque", motivo: `${input.dias_estoque.toFixed(0)} dias de estoque > limite ${c.dias_estoque_max}d e o item não gera valor.`, impacto_rs: null });
  if (r.length === 0 && input.evp != null && input.evp > 0) r.push({ acao: "Crescer / proteger", motivo: "Gera valor econômico positivo e sem alertas.", impacto_rs: null });
  return r;
}
function scoreConfiancaCockpit(input: { cobertura_receita: number; custo_ausente_pct: number; ar_indisponivel_pct: number; estoque_ausente_pct: number; imposto_estimado: boolean }) {
  const motivos: string[] = []; let nivel = 3;
  const rebaixar = (para: number, m: string) => { if (para < nivel) nivel = para; motivos.push(m); };
  if (input.cobertura_receita < 0.6) rebaixar(1, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% — muita venda fora do app; cockpit parcial.`);
  else if (input.cobertura_receita < 0.85) rebaixar(2, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% (ideal ≥85%).`);
  if (input.custo_ausente_pct > 0.4) rebaixar(1, `${(input.custo_ausente_pct * 100).toFixed(0)}% das células sem custo — margem indisponível em boa parte.`);
  else if (input.custo_ausente_pct > 0.15) rebaixar(2, `${(input.custo_ausente_pct * 100).toFixed(0)}% sem custo cadastrado.`);
  if (input.ar_indisponivel_pct > 0.3) rebaixar(2, `${(input.ar_indisponivel_pct * 100).toFixed(0)}% das vendas sem AR vinculável — encargo de cliente subestimado.`);
  if (input.estoque_ausente_pct > 0.3) rebaixar(2, `${(input.estoque_ausente_pct * 100).toFixed(0)}% dos SKUs sem estoque — encargo de SKU subestimado.`);
  if (input.imposto_estimado) motivos.push("Imposto alocado nível-empresa (estimado), não por linha.");
  return { nivel: (nivel === 3 ? "alta" : nivel === 2 ? "media" : "baixa") as "alta" | "media" | "baixa", motivos };
}

// ===== Orquestração =====
const COMPANY = "oben";
const CONFIG_DEFAULT: CockpitConfig = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeGestorOuMaster(req);
  if (!auth.ok) return auth.response;
  const db = createClient(SUPABASE_URL, SERVICE_ROLE);

  const now = new Date();
  const ttm_fim = now.toISOString().slice(0, 10);
  const ttm_inicio = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);

  // WACC (A2) — reusa fin_valor_inputs.ke.base; fallback default se ausente.
  const { data: viRow } = await db.from("fin_valor_inputs").select("valor_inputs").eq("company", COMPANY).maybeSingle();
  const vi = ((viRow as { valor_inputs?: Record<string, any> } | null)?.valor_inputs ?? {}) as Record<string, any>;
  const keBase = vi.ke?.base;
  const k = keBase ? (Number(keBase.ancora || 0) + Number(keBase.premio_risco_equity || 0) + Number(keBase.premio_tamanho_private || 0) + Number(keBase.premio_iliquidez_controle || 0)) : 0.20;

  // Config (limiares)
  const { data: cfgRow } = await db.from("fin_config_cashflow").select("cockpit_config").eq("company", COMPANY).maybeSingle();
  const cfgRaw = ((cfgRow as { cockpit_config?: Record<string, unknown> } | null)?.cockpit_config ?? {}) as Record<string, unknown>;
  const numOr = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : d);
  const config: CockpitConfig = {
    margem_minima_pct: numOr(cfgRaw.margem_minima_pct, CONFIG_DEFAULT.margem_minima_pct),
    desconto_max_pct: numOr(cfgRaw.desconto_max_pct, CONFIG_DEFAULT.desconto_max_pct),
    prazo_alvo_dias: numOr(cfgRaw.prazo_alvo_dias, CONFIG_DEFAULT.prazo_alvo_dias),
    dias_estoque_max: numOr(cfgRaw.dias_estoque_max, CONFIG_DEFAULT.dias_estoque_max),
    sample_min_receita: numOr(cfgRaw.sample_min_receita, CONFIG_DEFAULT.sample_min_receita),
  };

  // 1) Linhas de venda TTM (order_items × sales_orders pra data) — paginado simples (limite alto).
  const { data: orders } = await db.from("sales_orders").select("id, created_at").gte("created_at", ttm_inicio);
  const orderIds = (orders ?? []).map((o: { id: string }) => o.id);
  if (orderIds.length === 0) return jsonResponse({ company: COMPANY, vazio: true, motivo: "Sem pedidos no TTM." }, 200);
  const { data: items } = await db.from("order_items").select("sales_order_id, customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, discount").in("sales_order_id", orderIds);
  const linhas = (items ?? []) as Array<{ customer_user_id: string; product_id: string | null; omie_codigo_produto: number | null; quantity: number; unit_price: number; discount: number | null }>;

  // 2) Mapas de apoio
  const userIds = [...new Set(linhas.map((l) => l.customer_user_id))];
  const productIds = [...new Set(linhas.map((l) => l.product_id).filter(Boolean) as string[])];
  const { data: clientes } = await db.from("omie_clientes").select("user_id, omie_codigo_cliente").in("user_id", userIds);
  const userToOmie = new Map((clientes ?? []).map((c: { user_id: string; omie_codigo_cliente: number }) => [c.user_id, String(c.omie_codigo_cliente)]));
  const { data: custos } = await db.from("product_costs").select("product_id, cost_price").in("product_id", productIds);
  const custoPorProduto = new Map((custos ?? []).map((c: { product_id: string; cost_price: number }) => [c.product_id, c.cost_price]));
  const { data: estoque } = await db.from("inventory_position").select("omie_codigo_produto, saldo, cmc, account");
  const estoquePorSKU = new Map((estoque ?? []).filter((e: { account: string }) => e.account === COMPANY || e.account === "vendas").map((e: { omie_codigo_produto: number; saldo: number; cmc: number }) => [String(e.omie_codigo_produto), { saldo: e.saldo, cmc: e.cmc }]));

  // 3) Combos cliente×SKU
  const comboMap = new Map<string, { cliente: string; sku: string; receita: number; qtd: number; desconto: number; product_id: string | null }>();
  for (const l of linhas) {
    const cliente = userToOmie.get(l.customer_user_id) ?? "sem_cliente";
    const sku = l.omie_codigo_produto != null ? String(l.omie_codigo_produto) : "sem_sku";
    const key = `${cliente}|${sku}`;
    const receita = l.unit_price * l.quantity - (l.discount ?? 0);
    const acc = comboMap.get(key) ?? { cliente, sku, receita: 0, qtd: 0, desconto: 0, product_id: l.product_id };
    acc.receita += receita; acc.qtd += l.quantity; acc.desconto += (l.discount ?? 0);
    comboMap.set(key, acc);
  }
  const combos: ComboInput[] = [...comboMap.values()].map((c) => ({ cliente: c.cliente, sku: c.sku, receita_liquida: c.receita, quantidade: c.qtd, custo_unitario: c.product_id ? (custoPorProduto.get(c.product_id) ?? null) : null }));

  // 4) Capital por cliente (AR médio TTM) e por SKU (estoque)
  const omieCods = [...new Set(combos.map((c) => c.cliente).filter((c) => c !== "sem_cliente"))];
  const { data: crs } = await db.from("fin_contas_receber").select("omie_codigo_cliente, valor_documento, saldo, data_emissao, data_recebimento, status_titulo").eq("company", COMPANY).in("omie_codigo_cliente", omieCods.map(Number));
  const titulosPorCliente = new Map<string, TituloAR[]>();
  for (const t of (crs ?? []) as Array<{ omie_codigo_cliente: number; valor_documento: number; saldo: number; data_emissao: string | null; data_recebimento: string | null; status_titulo: string }>) {
    const key = String(t.omie_codigo_cliente);
    const arr = titulosPorCliente.get(key) ?? [];
    arr.push({ valor_documento: t.valor_documento, saldo: t.saldo, data_emissao: t.data_emissao, data_recebimento: t.data_recebimento, status: t.status_titulo });
    titulosPorCliente.set(key, arr);
  }
  const capitalClientes: CapitalCliente[] = [...new Set(combos.map((c) => c.cliente))].map((cliente) => ({
    cliente,
    ar_medio: cliente === "sem_cliente" ? null : (titulosPorCliente.has(cliente) ? arMedioTTM({ titulos: titulosPorCliente.get(cliente)!, ttm_inicio, ttm_fim }) : null),
  }));
  const capitalSKUs: CapitalSKU[] = [...new Set(combos.map((c) => c.sku))].map((sku) => {
    const e = estoquePorSKU.get(sku);
    return { sku, estoque_valor: e ? e.saldo * e.cmc : null };
  });

  // 5) Monta EVP
  const res = montarCelulasComboEVP({ combos, capitalClientes, capitalSKUs, k });

  // 6) Recomendações por cliente (usa PMR médio do cliente como prazo; desconto agregado)
  const descontoPorCliente = new Map<string, number>();
  for (const c of [...comboMap.values()]) descontoPorCliente.set(c.cliente, (descontoPorCliente.get(c.cliente) ?? 0) + c.desconto);
  const recomendacoesCliente = res.porCliente.map((rc) => ({
    cliente: rc.cliente,
    recomendacoes: recomendarAcaoComercial({ evp: rc.evp, receita_liquida: rc.receita, cm: rc.cm, desconto_total: descontoPorCliente.get(rc.cliente) ?? 0, prazo_medio_dias: 0, dias_estoque: 0, config }),
  }));

  // 7) Confiança
  const total = res.celulas.length || 1;
  const custo_ausente_pct = res.celulas.filter((c) => c.cm == null).length / total;
  const ar_indisponivel_pct = res.celulas.filter((c) => c.ar_indisponivel).length / total;
  const estoque_ausente_pct = res.celulas.filter((c) => c.estoque_indisponivel).length / total;
  // cobertura de receita: receita do cockpit ÷ receita-AR total da Oben no TTM
  const { data: arTotalRows } = await db.from("fin_contas_receber").select("valor_documento").eq("company", COMPANY).gte("data_emissao", ttm_inicio);
  const arTotal = (arTotalRows ?? []).reduce((s: number, t: { valor_documento: number }) => s + (t.valor_documento || 0), 0);
  const cobertura_receita = arTotal > 0 ? Math.min(1, res.empresa.receita / arTotal) : 1;
  const confianca = scoreConfiancaCockpit({ cobertura_receita, custo_ausente_pct, ar_indisponivel_pct, estoque_ausente_pct, imposto_estimado: true });

  return jsonResponse({
    company: COMPANY, k, ttm: { inicio: ttm_inicio, fim: ttm_fim },
    porCliente: res.porCliente, porSKU: res.porSKU, empresa: res.empresa,
    recomendacoesCliente, confianca, cobertura_receita, config,
  }, 200);
});
```

- [ ] **Step 2: `deno check`**

Run: `deno check supabase/functions/fin-valor-cockpit/index.ts`
Expected: sem erros NOVOS no arquivo (ignorar artefatos pré-existentes de outras funções). Cross-check: as funções espelhadas batem com `valor-cockpit-helpers.ts`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/fin-valor-cockpit/index.ts
git commit -m "feat(financeiro a3): edge function fin-valor-cockpit (gestor+master; espelha helper; Oben)"
```

---

## Task 7: Tipos + hook `useValorCockpit`

**Files:**
- Modify: `src/services/financeiroService.ts`
- Create: `src/hooks/useValorCockpit.ts`

- [ ] **Step 1: Tipos no fim de `financeiroService.ts`**

```ts
// ═══════════════ A3 — Cockpit de Valor (contrato com fin-valor-cockpit) ═══════════════
export interface CockpitConfig {
  margem_minima_pct: number; desconto_max_pct: number; prazo_alvo_dias: number; dias_estoque_max: number; sample_min_receita: number;
}
export interface CockpitRecomendacao { acao: string; motivo: string; impacto_rs: number | null }
export interface CockpitRollupCliente { cliente: string; receita: number; cm: number | null; encargo: number; evp: number | null }
export interface CockpitRollupSKU { sku: string; receita: number; quantidade: number; cm: number | null; encargo: number; evp: number | null }
export interface ValorCockpitResult {
  company: string;
  k: number;
  ttm: { inicio: string; fim: string };
  vazio?: boolean;
  motivo?: string;
  porCliente: CockpitRollupCliente[];
  porSKU: CockpitRollupSKU[];
  empresa: { receita: number; cm: number | null; encargo: number; evp: number | null };
  recomendacoesCliente: Array<{ cliente: string; recomendacoes: CockpitRecomendacao[] }>;
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  cobertura_receita: number;
  config: CockpitConfig;
}
```

- [ ] **Step 2: Criar `src/hooks/useValorCockpit.ts`**

```ts
// src/hooks/useValorCockpit.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ValorCockpitResult } from '@/services/financeiroService';

export function useValorCockpit() {
  return useQuery({
    queryKey: ['fin_valor_cockpit', 'oben'],
    queryFn: async (): Promise<ValorCockpitResult> => {
      const { data, error } = await supabase.functions.invoke('fin-valor-cockpit', { body: {} });
      if (error) throw error;
      return data as ValorCockpitResult;
    },
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: sem erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/services/financeiroService.ts src/hooks/useValorCockpit.ts
git commit -m "feat(financeiro a3): tipos do contrato + hook useValorCockpit"
```

---

## Task 8: Página + rota + sidebar (gate gestor+master)

**Files:**
- Create: `src/pages/FinanceiroValorCockpit.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Criar `src/pages/FinanceiroValorCockpit.tsx`**

```tsx
// src/pages/FinanceiroValorCockpit.tsx
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useValorCockpit } from '@/hooks/useValorCockpit';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';

const brl = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
function nivelClasses(n: 'alta' | 'media' | 'baixa') {
  if (n === 'alta') return 'text-status-success bg-status-success-bg';
  if (n === 'media') return 'text-status-warning bg-status-warning-bg';
  return 'text-status-error bg-status-error-bg';
}

export default function FinanceiroValorCockpit() {
  const { isMaster, isGestorComercial } = useAuth();
  const [aba, setAba] = useState<'cliente' | 'sku'>('cliente');
  const podeVer = isMaster || isGestorComercial;
  const { data, isLoading, error } = useValorCockpit();

  if (!podeVer) {
    return <div className="p-6"><Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Acesso restrito — Cockpit de Valor é visível a gestor comercial e master.</CardContent></Card></div>;
  }
  if (isLoading) return <div className="p-6"><PageSkeleton variant="list" /></div>;
  if (error) return <div className="p-6"><Card><CardContent className="py-6 text-sm text-status-error">Erro: {error instanceof Error ? error.message : String(error)}</CardContent></Card></div>;
  if (!data || data.vazio) return <div className="p-6"><Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{data?.motivo ?? 'Sem dados de venda no período.'}</CardContent></Card></div>;

  const linhas = aba === 'cliente'
    ? [...data.porCliente].sort((a, b) => (a.evp ?? Infinity) - (b.evp ?? Infinity))
    : [...data.porSKU].sort((a, b) => (a.evp ?? Infinity) - (b.evp ?? Infinity));
  const recPorCliente = new Map(data.recomendacoesCliente.map((r) => [r.cliente, r.recomendacoes]));

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl">Cockpit de Valor — Oben</h1>
          <p className="text-sm text-muted-foreground">Lucro econômico (margem − custo do capital de giro @ {(data.k * 100).toFixed(1)}%) por cliente e SKU.</p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded ${nivelClasses(data.confianca.nivel)}`}>confiança {data.confianca.nivel}</span>
      </div>

      <div className="flex gap-2">
        <Button variant={aba === 'cliente' ? 'default' : 'outline'} size="sm" onClick={() => setAba('cliente')}>Por cliente</Button>
        <Button variant={aba === 'sku' ? 'default' : 'outline'} size="sm" onClick={() => setAba('sku')}>Por SKU</Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Piores destruidores de valor primeiro</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <table className="w-full">
            <thead><tr className="text-muted-foreground text-xs"><th className="text-left py-1">{aba === 'cliente' ? 'Cliente' : 'SKU'}</th><th className="text-right">Receita</th><th className="text-right">Margem</th><th className="text-right">Encargo giro</th><th className="text-right">Lucro econ.</th><th className="text-left pl-3">Ação</th></tr></thead>
            <tbody>
              {linhas.slice(0, 50).map((row) => {
                const id = aba === 'cliente' ? (row as { cliente: string }).cliente : (row as { sku: string }).sku;
                const recs = aba === 'cliente' ? (recPorCliente.get(id) ?? []) : [];
                return (
                  <tr key={id} className="border-t border-border">
                    <td className="py-1 font-tabular">{id}</td>
                    <td className="text-right">{brl(row.receita)}</td>
                    <td className="text-right">{brl(row.cm)}</td>
                    <td className="text-right text-muted-foreground">{brl(row.encargo)}</td>
                    <td className={`text-right kpi-value ${row.evp != null && row.evp < 0 ? 'text-status-error' : 'text-status-success'}`}>{brl(row.evp)}</td>
                    <td className="pl-3 text-xs">{recs.map((r, i) => <div key={i}>{r.acao}{r.impacto_rs != null ? ` (~${brl(r.impacto_rs)})` : ''}</div>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.confianca.motivos.length > 0 && (
            <details className="text-xs text-muted-foreground mt-3"><summary>Confiança ({(data.cobertura_receita * 100).toFixed(0)}% de cobertura de receita)</summary><ul className="list-disc pl-4 mt-1">{data.confianca.motivos.map((m, i) => <li key={i}>{m}</li>)}</ul></details>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">Direcional: custo é médio atual (sem BOM), imposto estimado nível-empresa, estoque é snapshot run-rate. Escopo: Oben.</p>
    </div>
  );
}
```

- [ ] **Step 2: Adicionar `isGestorComercial` ao AuthContext (se não existir)**

Verificar em `src/contexts/AuthContext.tsx` se há `isGestorComercial`. Se NÃO houver, adicionar: ler `commercial_roles.commercial_role` do usuário (já pode haver `commercialRole`); expor `isGestorComercial = ['gerencial','estrategico','super_admin'].includes(commercialRole ?? '')`. Seguir o padrão existente de fetch de role no AuthContext. Se já existir um campo equivalente, usar ele e ajustar a página.

> Se o AuthContext não tiver commercial role e adicioná-lo for grande, fazer a página buscar via query própria (`commercial_roles` por `user.id`) com um hook pequeno `useIsGestorComercial`, em vez de inchar o AuthContext. Decisão do implementador conforme o que o AuthContext já expõe.

- [ ] **Step 3: Rota em `src/App.tsx`**

Lazy import junto aos `Financeiro*`:
```tsx
const FinanceiroValorCockpit = lazy(() => import("./pages/FinanceiroValorCockpit"));
```
Rota junto às `financeiro/*`:
```tsx
              <Route path="financeiro/valor-cockpit" element={<FinanceiroValorCockpit />} />
```

- [ ] **Step 4: Link sidebar em `src/components/AppShell.tsx`**

Na seção Financeiro do `unifiedNavSections`, adicionar (gate gestor+master). Como o AppShell já tem `masterOnly` e filtra por `isMaster`/`isStaff`, estender o filtro pra suportar gestor comercial: adicionar campo `gestorComercialOuMaster?: boolean` ao `NavItem` e, nos filtros (AppSidebar favoritos, AppSidebar seções, MobileNav), incluir `&& (!item.gestorComercialOuMaster || isMaster || isGestorComercial)`. Extrair `isGestorComercial` de `useAuth()` (ou do hook `useIsGestorComercial`). Item:
```tsx
{ icon: Crosshair, label: 'Cockpit de Valor', path: '/financeiro/valor-cockpit', gestorComercialOuMaster: true },
```
> Seguir EXATAMENTE o padrão dos filtros existentes (ver como `masterOnly` foi adicionado na A2). Ler a estrutura real antes de editar.

- [ ] **Step 5: Validar**

Run: `bunx tsc --noEmit && bun lint && bun run build`
Expected: PASS; zero lint novo.

- [ ] **Step 6: Commit**

```bash
git add src/pages/FinanceiroValorCockpit.tsx src/App.tsx src/components/AppShell.tsx src/contexts/AuthContext.tsx
git commit -m "feat(financeiro a3): página /financeiro/valor-cockpit (gestor+master) + rota + sidebar"
```

---

## Task 9: Docs — seção A3 em `FINANCEIRO_CONFIABILIDADE.md`

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md` (após a seção A2)

- [ ] **Step 1: Inserir a seção A3**

```markdown
## 🔧 A3 — Inteligência de Valor (Cockpit cliente/produto) (2026-05-24)

Para de olhar faturamento e olha **lucro econômico** por cliente/SKU: margem de contribuição **menos o custo do capital de giro** (recebíveis + estoque parados) cobrado ao hurdle-rate da A2. Escopo MVP: **Oben** (onde há linha de SKU no app). Gate: gestor comercial + master.

| Item | Como é calculado |
|---|---|
| **Lucro econômico (EVP)** | Tabela atômica cliente×SKU: `EVP_cs = CM_cs − k×(A_cs + I_cs)`. AR do cliente alocado por receita; estoque do SKU por quantidade. Cliente/SKU/empresa reconciliam. |
| **Margem de contribuição** | `receita_líquida − custo×qtd` (`product_costs`, custo médio atual; sem BOM). Custo ausente → null. |
| **Encargo de capital** | AR = saldo médio TTM (time-weighted) × WACC; estoque = `saldo×cmc` (snapshot run-rate) × WACC. AP = crédito nível-empresa (não rateado). |
| **Recomendações** | Regras determinísticas: cortar desconto / subir preço / encurtar prazo / despriorizar SKU / crescer, com R$ em jogo. Limiares em `fin_config_cashflow.cockpit_config`. |
| **Confiança** | Cobertura de receita (order_items ÷ AR), custo/AR/estoque ausentes, imposto estimado nível-empresa. |

**Regra de ouro:** direcional, não verdade contábil. Custo sem BOM; imposto estimado nível-empresa; estoque snapshot; cobertura depende do sync de vendas. Nunca fabrica: ausente = null + motivo.

**Onde:** helper `valor-cockpit-helpers.ts` (vitest); engine `fin-valor-cockpit` (gestor+master); coluna `fin_config_cashflow.cockpit_config`; página `/financeiro/valor-cockpit`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/FINANCEIRO_CONFIABILIDADE.md
git commit -m "docs(financeiro a3): seção Cockpit de Valor em CONFIABILIDADE"
```

---

## Task 10: Validação final + entregáveis

- [ ] **Step 1: Suíte do CI**

Run: `bun run test && bun run typecheck:strict && bunx tsc --noEmit && bun lint && bun run build`
Expected: tudo verde; zero lint novo.

- [ ] **Step 2: `deno check` + não-regressão**

Run: `deno check supabase/functions/fin-valor-cockpit/index.ts`
Run: `git diff --stat origin/main..HEAD -- supabase/functions/fin-valor-engine supabase/functions/fin-cashflow-engine supabase/functions/omie-financeiro` (deve estar vazio — A3 não toca os engines anteriores).

- [ ] **Step 3: Entregáveis ao founder**
   (a) BLOCO SQL `cockpit_config` (Task 5) pro SQL Editor do Lovable.
   (b) Prompt de deploy: criar a edge function `fin-valor-cockpit` lendo `supabase/functions/fin-valor-cockpit/index.ts` da main, verbatim.
   (c) Lembrete: rodar o SQL antes; sem ele usa defaults.

- [ ] **Step 4: Finishing** — usar superpowers:finishing-a-development-branch (PR com nota de migration manual; admin-merge só se autorizado).

---

## Self-Review (autor do plano)

**Cobertura do spec:** lucro econômico/tabela atômica → Task 2 ✅; margem → Task 1 ✅; AR médio → Task 1 ✅; estoque/encargo → engine Task 6 ✅; recomendações preço/prazo → Task 3 ✅; confiança/cobertura → Task 4 + engine ✅; config → Task 5 ✅; engine gestor+master → Task 6 ✅; hook/tipos → Task 7 ✅; página gate → Task 8 ✅; docs → Task 9 ✅; escopo Oben + degradação honesta → engine + página ✅.

**Placeholders:** Task 8 Step 2 (isGestorComercial no AuthContext) e Step 4 (filtro sidebar) deixam decisão ao implementador conforme o que o AuthContext/AppShell já expõem — é leitura-de-padrão-local exigida, não placeholder de código (o resto tem código completo). O implementador deve ler `AuthContext.tsx` e `AppShell.tsx` antes (igual fizemos na A2).

**Consistência de tipos:** `ComboInput`/`CapitalCliente`/`CapitalSKU`/`CelulaEVP`/`RollupCliente`/`RollupSKU`/`ComboEVPResult`/`CockpitConfig`/`Recomendacao`/`ConfiancaCockpit` batem entre helper (Tasks 1-4), engine (Task 6, espelhado) e contrato do serviço (Task 7: `ValorCockpitResult` etc.). Chaves de combo `${cliente}|${sku}` consistentes. WACC `k` derivado de `fin_valor_inputs.ke.base` (A2) com fallback 0.20.

**Pontos de atenção (execução):** (a) `order_items` cobre só vendas via app → cobertura de receita medida e exibida; (b) estoque é snapshot (run-rate), documentado; (c) o AuthContext pode não ter commercial role — Task 8 resolve via campo novo ou hook pequeno; (d) `inventory_position.account` pode ser 'oben' ou 'vendas' — engine aceita ambos (confirmar no apply).
