# Onda 2 — Timing da Projeção 13s · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o modelo de timing de recebíveis da projeção 13s por curvas de cobrança por faixa de aging, calibradas por exposição (sem viés), com +90 separando recuperação de perda, ponte de horizonte, cenários com clamp e PMR/PMP ponderado por R$.

**Architecture:** Toda a matemática nova vive num módulo puro e testável `src/lib/financeiro/aging-helpers.ts` (vitest), e é espelhada verbatim no engine Deno `supabase/functions/fin-cashflow-engine/index.ts`. TDD acontece no helper frontend; o engine replica as mesmas funções. Sem migration obrigatória (curvas calibradas em runtime; persistidas em `premissas` do snapshot).

**Tech Stack:** TypeScript + vitest, Supabase edge function (Deno) no Lovable, React + recharts.

**Restrições Lovable (CRÍTICO):** edge function re-deployada via chat do Lovable lendo o arquivo do repo; SQL (se houver) via SQL Editor; frontend buildado pelo Lovable do repo. **Não commitar sem o founder pedir.**

---

## File Structure

- **Create** `src/lib/financeiro/aging-helpers.ts` — funções puras: `faixaAging`, `calibrarCurvas`, `dataRecebimentoEsperada`, `aplicarCenarioCurva`, `inadimplenciaPonderada`, `pmrPonderado`/`pmpPonderado`, `mediaPonderada`/`mediana`.
- **Create** `src/lib/financeiro/__tests__/aging-helpers.test.ts` — testes vitest.
- **Modify** `supabase/functions/fin-cashflow-engine/index.ts` — espelha as funções; `calcularCurvasAging` substitui o miolo de `calcularTaxasHistoricas`; `gerarSemanas` aloca por aging + ponte de horizonte; `aplicarCenario` usa clamps; `calcularIndicadores` PMR/PMP ponderado + inadimplência ponderada; `calcularNCG` guard de folha por janela.
- **Modify** `src/hooks/useCashflowProjection.ts` — type da resposta ganha `curvas_aging`, `apos_horizonte`, `ar_impaired`.
- **Modify** `src/components/financeiro/cashflow/Fluxo13Semanas.tsx` — linha "esperado após horizonte / AR impaired" + tabela de curvas (taxa/lag/confiança).
- **Modify** `docs/FINANCEIRO_CONFIABILIDADE.md` — seção Onda 2.

### Tipos compartilhados (definidos no aging-helpers.ts)
```ts
export type Faixa = 'a_vencer' | '1-30' | '31-60' | '61-90' | '+90';
export type CurvaFaixa = {
  taxa_recebimento: number; // [0,1]
  lag_dias: number;         // média ponderada por R$ do atraso total (recebimento - vencimento)
  lag_mediana: number;
  exposicao: number;
  pago: number;
  aberto: number;
  confianca: 'alta' | 'baixa';
};
export type TituloHist = {
  valor_documento: number; valor_recebido: number; saldo: number;
  data_vencimento: string | null; data_recebimento: string | null; status_titulo: string;
};
export const FAIXAS: Faixa[] = ['a_vencer','1-30','31-60','61-90','+90'];
export const LAG_MAX: Record<Faixa, number> = { 'a_vencer':45, '1-30':60, '31-60':90, '61-90':120, '+90':365 };
export const CURVA_DEFAULT: Record<Faixa, { taxa_recebimento: number; lag_dias: number }> = {
  'a_vencer': { taxa_recebimento: 0.98, lag_dias: 5 },
  '1-30':     { taxa_recebimento: 0.95, lag_dias: 20 },
  '31-60':    { taxa_recebimento: 0.90, lag_dias: 40 },
  '61-90':    { taxa_recebimento: 0.80, lag_dias: 70 },
  '+90':      { taxa_recebimento: 0.50, lag_dias: 150 },
};
```

---

## Task 1: `faixaAging` + util de datas (TDD)

**Files:**
- Create: `src/lib/financeiro/aging-helpers.ts`
- Test: `src/lib/financeiro/__tests__/aging-helpers.test.ts`

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, it, expect } from 'vitest';
import { faixaAging, daysBetween, addDays } from '../aging-helpers';

describe('faixaAging', () => {
  it('não vencido ou vence hoje → a_vencer', () => {
    expect(faixaAging(0)).toBe('a_vencer');
    expect(faixaAging(-5)).toBe('a_vencer');
  });
  it('limites das faixas', () => {
    expect(faixaAging(1)).toBe('1-30');
    expect(faixaAging(30)).toBe('1-30');
    expect(faixaAging(31)).toBe('31-60');
    expect(faixaAging(60)).toBe('31-60');
    expect(faixaAging(61)).toBe('61-90');
    expect(faixaAging(90)).toBe('61-90');
    expect(faixaAging(91)).toBe('+90');
    expect(faixaAging(400)).toBe('+90');
  });
});

describe('daysBetween / addDays', () => {
  it('daysBetween em dias inteiros', () => {
    expect(daysBetween('2026-05-19', '2026-05-09')).toBe(10);
  });
  it('addDays soma dias (UTC)', () => {
    expect(addDays('2026-05-19', 7)).toBe('2026-05-26');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- aging-helpers`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

Criar `src/lib/financeiro/aging-helpers.ts` com os tipos do bloco "Tipos compartilhados" acima, mais:
```ts
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000);
}
export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}
export function faixaAging(diasAtraso: number): Faixa {
  if (diasAtraso <= 0) return 'a_vencer';
  if (diasAtraso <= 30) return '1-30';
  if (diasAtraso <= 60) return '31-60';
  if (diasAtraso <= 90) return '61-90';
  return '+90';
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- aging-helpers`
Expected: PASS.

---

## Task 2: `mediaPonderada` + `mediana` (TDD)

**Files:**
- Modify: `src/lib/financeiro/aging-helpers.ts`
- Test: `src/lib/financeiro/__tests__/aging-helpers.test.ts`

- [ ] **Step 1: Testes**

Append:
```ts
import { mediaPonderada, mediana } from '../aging-helpers';

describe('mediaPonderada', () => {
  it('pondera por peso (R$)', () => {
    // título grande lento (100k, 70d) + pequeno rápido (1k, 5d)
    expect(mediaPonderada([{ valor: 70, peso: 100000 }, { valor: 5, peso: 1000 }])).toBeCloseTo(69.36, 1);
  });
  it('peso total 0 → 0', () => {
    expect(mediaPonderada([{ valor: 10, peso: 0 }])).toBe(0);
  });
});
describe('mediana', () => {
  it('ímpar', () => { expect(mediana([5, 1, 3])).toBe(3); });
  it('par = média dos centrais', () => { expect(mediana([1, 2, 3, 4])).toBe(2.5); });
  it('vazio → 0', () => { expect(mediana([])).toBe(0); });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- aging-helpers` → FAIL (não exportados).

- [ ] **Step 3: Implementar**

Append a `aging-helpers.ts`:
```ts
export function mediaPonderada(itens: Array<{ valor: number; peso: number }>): number {
  const somaPeso = itens.reduce((s, i) => s + i.peso, 0);
  if (somaPeso <= 0) return 0;
  return itens.reduce((s, i) => s + i.valor * i.peso, 0) / somaPeso;
}
export function mediana(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- aging-helpers` → PASS.

---

## Task 3: `calibrarCurvas` por exposição (TDD — o coração)

**Files:**
- Modify: `src/lib/financeiro/aging-helpers.ts`
- Test: `src/lib/financeiro/__tests__/aging-helpers.test.ts`

- [ ] **Step 1: Testes (viés removido + confiança)**

Append:
```ts
import { calibrarCurvas } from '../aging-helpers';

const hoje = '2026-05-19';

describe('calibrarCurvas (por exposição)', () => {
  it('aberto não-pago na faixa puxa a taxa pra baixo (sem viés)', () => {
    // 31-60: um liquidado pago (100k) + um aberto vencido há 45d ainda não pago (100k)
    const titulos = [
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_recebimento: '2026-04-24', status_titulo: 'RECEBIDO' }, // 35d atraso → 31-60
      { valor_documento: 100000, valor_recebido: 0, saldo: 100000, data_vencimento: '2026-04-04', data_recebimento: null, status_titulo: 'VENCIDO' }, // 45d atraso hoje → 31-60
    ];
    const curvas = calibrarCurvas(titulos, hoje, 20, 50000);
    // exposicao 31-60 = 200k, pago = 100k → taxa = 0.5 (NÃO 1.0 que o viés daria)
    expect(curvas['31-60'].taxa_recebimento).toBeCloseTo(0.5, 5);
    expect(curvas['31-60'].exposicao).toBe(200000);
    expect(curvas['31-60'].pago).toBe(100000);
    expect(curvas['31-60'].aberto).toBe(100000);
  });
  it('amostra fraca (poucos títulos) → confiança baixa + default', () => {
    const titulos = [
      { valor_documento: 1000, valor_recebido: 1000, saldo: 0, data_vencimento: '2026-05-10', data_recebimento: '2026-05-14', status_titulo: 'RECEBIDO' },
    ];
    const curvas = calibrarCurvas(titulos, hoje, 20, 50000);
    expect(curvas['1-30'].confianca).toBe('baixa');
    expect(curvas['1-30'].taxa_recebimento).toBe(CURVA_DEFAULT['1-30'].taxa_recebimento);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- aging-helpers` → FAIL.

- [ ] **Step 3: Implementar**

Append a `aging-helpers.ts`:
```ts
export function calibrarCurvas(
  titulos: TituloHist[],
  hoje: string,
  minTitulos = 20,
  minVolume = 50000,
): Record<Faixa, CurvaFaixa> {
  const acc: Record<Faixa, { exposicao: number; pago: number; aberto: number; count: number; topValor: number; lags: Array<{ valor: number; peso: number }>; lagsRaw: number[] }> =
    Object.fromEntries(FAIXAS.map(f => [f, { exposicao: 0, pago: 0, aberto: 0, count: 0, topValor: 0, lags: [], lagsRaw: [] }])) as any;

  for (const t of titulos) {
    if (!t.data_vencimento) continue;
    const liquidado = !!t.data_recebimento;
    const diasAtraso = liquidado
      ? daysBetween(t.data_recebimento!, t.data_vencimento)   // atraso na liquidação
      : daysBetween(hoje, t.data_vencimento);                 // atraso atual
    const faixa = faixaAging(diasAtraso);
    const a = acc[faixa];
    a.exposicao += t.valor_documento;
    a.count += 1;
    a.topValor = Math.max(a.topValor, t.valor_documento);
    if (liquidado) {
      a.pago += t.valor_recebido;
      const lag = Math.max(0, daysBetween(t.data_recebimento!, t.data_vencimento));
      a.lags.push({ valor: lag, peso: t.valor_recebido });
      a.lagsRaw.push(lag);
    } else {
      a.aberto += t.saldo;
    }
  }

  const out = {} as Record<Faixa, CurvaFaixa>;
  for (const f of FAIXAS) {
    const a = acc[f];
    const volOk = a.exposicao >= minVolume;
    const countOk = a.count >= minTitulos;
    const concentracaoOk = a.exposicao > 0 ? (a.topValor / a.exposicao) <= 0.6 : false;
    const confiavel = countOk && volOk && concentracaoOk;
    if (confiavel) {
      out[f] = {
        taxa_recebimento: Math.min(1, Math.max(0, a.exposicao > 0 ? a.pago / a.exposicao : 0)),
        lag_dias: mediaPonderada(a.lags),
        lag_mediana: mediana(a.lagsRaw),
        exposicao: a.exposicao, pago: a.pago, aberto: a.aberto,
        confianca: 'alta',
      };
    } else {
      out[f] = {
        taxa_recebimento: CURVA_DEFAULT[f].taxa_recebimento,
        lag_dias: CURVA_DEFAULT[f].lag_dias,
        lag_mediana: CURVA_DEFAULT[f].lag_dias,
        exposicao: a.exposicao, pago: a.pago, aberto: a.aberto,
        confianca: 'baixa',
      };
    }
  }
  return out;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- aging-helpers` → PASS.

---

## Task 4: `dataRecebimentoEsperada` + `aplicarCenarioCurva` (TDD)

**Files:**
- Modify: `src/lib/financeiro/aging-helpers.ts`
- Test: `src/lib/financeiro/__tests__/aging-helpers.test.ts`

- [ ] **Step 1: Testes**

Append:
```ts
import { dataRecebimentoEsperada, aplicarCenarioCurva } from '../aging-helpers';

describe('dataRecebimentoEsperada', () => {
  it('a_vencer: vencimento + lag', () => {
    expect(dataRecebimentoEsperada({ data_vencimento: '2026-06-01', hoje: '2026-05-19', faixa: 'a_vencer', lag_dias_faixa: 5 })).toBe('2026-06-06');
  });
  it('vencido: hoje + lag restante (lag - atraso atual), nunca hoje seco', () => {
    // vencido há 10d, faixa 1-30 lag 20 → restante 10 → hoje+10
    expect(dataRecebimentoEsperada({ data_vencimento: '2026-05-09', hoje: '2026-05-19', faixa: '1-30', lag_dias_faixa: 20 })).toBe('2026-05-29');
  });
  it('vencido além do lag esperado: usa residual default (não cai hoje)', () => {
    // +90 lag 150, atraso atual 200 → restante seria <0 → usa residual 15 → hoje+15
    expect(dataRecebimentoEsperada({ data_vencimento: '2025-11-01', hoje: '2026-05-19', faixa: '+90', lag_dias_faixa: 150, lag_residual_default: 15 })).toBe('2026-06-03');
  });
});

describe('aplicarCenarioCurva (clamps)', () => {
  const base = { taxa_recebimento: 0.8, lag_dias: 70, lag_mediana: 60, exposicao: 0, pago: 0, aberto: 0, confianca: 'alta' as const };
  it('otimista: taxa sobe (perda cai), lag cai, dentro dos limites', () => {
    const r = aplicarCenarioCurva(base, '61-90', { recebimento_no_prazo_pct_delta: 10, inadimplencia_pct_delta: -50 });
    expect(r.taxa_recebimento).toBeCloseTo(0.9, 5); // perda 0.2 *0.5 = 0.1 → taxa 0.9
    expect(r.lag_dias).toBeCloseTo(63, 5);          // 70 * 0.9
  });
  it('pessimista: taxa cai, lag sobe mas respeita LAG_MAX', () => {
    const r = aplicarCenarioCurva({ ...base, lag_dias: 115 }, '61-90', { recebimento_no_prazo_pct_delta: -15, inadimplencia_pct_delta: 50 });
    expect(r.taxa_recebimento).toBeCloseTo(0.7, 5); // perda 0.2*1.5=0.3 → 0.7
    expect(r.lag_dias).toBe(120);                   // 115*1.15=132.25 → clamp LAG_MAX[61-90]=120
  });
  it('taxa nunca passa de 1 nem fica negativa', () => {
    const r = aplicarCenarioCurva({ ...base, taxa_recebimento: 0.95 }, 'a_vencer', { recebimento_no_prazo_pct_delta: 0, inadimplencia_pct_delta: -200 });
    expect(r.taxa_recebimento).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- aging-helpers` → FAIL.

- [ ] **Step 3: Implementar**

Append a `aging-helpers.ts`:
```ts
export function dataRecebimentoEsperada(input: {
  data_vencimento: string; hoje: string; faixa: Faixa; lag_dias_faixa: number; lag_residual_default?: number;
}): string {
  const residual = input.lag_residual_default ?? 15;
  if (input.faixa === 'a_vencer') {
    return addDays(input.data_vencimento, input.lag_dias_faixa);
  }
  const diasAtraso = daysBetween(input.hoje, input.data_vencimento); // positivo
  const lagRestante = Math.max(input.lag_dias_faixa - diasAtraso, residual);
  return addDays(input.hoje, lagRestante);
}

export function aplicarCenarioCurva(
  curva: CurvaFaixa,
  faixa: Faixa,
  deltas: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number },
): CurvaFaixa {
  const perda = 1 - curva.taxa_recebimento;
  const perdaNova = perda * (1 + deltas.inadimplencia_pct_delta / 100);
  const taxa = Math.min(1, Math.max(0, 1 - perdaNova));
  const lagBruto = curva.lag_dias * (1 - deltas.recebimento_no_prazo_pct_delta / 100);
  const lag = Math.min(LAG_MAX[faixa], Math.max(0, lagBruto));
  return { ...curva, taxa_recebimento: taxa, lag_dias: lag };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- aging-helpers` → PASS.

---

## Task 5: `inadimplenciaPonderada` + `pmrPonderado`/`pmpPonderado` (TDD)

**Files:**
- Modify: `src/lib/financeiro/aging-helpers.ts`
- Test: `src/lib/financeiro/__tests__/aging-helpers.test.ts`

- [ ] **Step 1: Testes**

Append:
```ts
import { inadimplenciaPonderada, prazoMedioPonderado } from '../aging-helpers';

describe('inadimplenciaPonderada', () => {
  it('média ponderada por R$ de (1 - taxa) sobre CR aberto', () => {
    const curvas = {
      'a_vencer': { taxa_recebimento: 1.0 }, '1-30': { taxa_recebimento: 0.9 },
      '31-60': { taxa_recebimento: 0.8 }, '61-90': { taxa_recebimento: 0.7 }, '+90': { taxa_recebimento: 0.5 },
    } as any;
    // 100k a_vencer (perda 0) + 100k +90 (perda 0.5) → ponderado = 0.25 = 25%
    const crs = [
      { saldo: 100000, faixa: 'a_vencer' as const },
      { saldo: 100000, faixa: '+90' as const },
    ];
    expect(inadimplenciaPonderada(crs, curvas)).toBeCloseTo(25, 5);
  });
});

describe('prazoMedioPonderado', () => {
  it('pondera por valor (não por contagem)', () => {
    // 1 título grande 100k em 70d + 1 pequeno 1k em 5d → ~69.4d, não 37.5
    expect(prazoMedioPonderado([
      { dias: 70, valor: 100000 }, { dias: 5, valor: 1000 },
    ])).toBeCloseTo(69.36, 1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- aging-helpers` → FAIL.

- [ ] **Step 3: Implementar**

Append:
```ts
export function inadimplenciaPonderada(
  crsAbertos: Array<{ saldo: number; faixa: Faixa }>,
  curvas: Record<Faixa, { taxa_recebimento: number }>,
): number {
  const itens = crsAbertos.map(c => ({ valor: 1 - curvas[c.faixa].taxa_recebimento, peso: c.saldo }));
  return mediaPonderada(itens) * 100;
}
export function prazoMedioPonderado(titulos: Array<{ dias: number; valor: number }>): number {
  return mediaPonderada(titulos.map(t => ({ valor: t.dias, peso: t.valor })));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- aging-helpers` → PASS. Depois rode a suíte inteira: `bun run test` (deve continuar 100%).

---

## Task 6: Espelhar no engine `fin-cashflow-engine`

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

> Não há vitest no Deno. Replique as funções do `aging-helpers.ts` VERBATIM (tipos `Faixa`, `CurvaFaixa`, `FAIXAS`, `LAG_MAX`, `CURVA_DEFAULT`, `faixaAging`, `daysBetween` já existe no engine — reusar, `addDays` já existe — reusar, `mediaPonderada`, `mediana`, `calibrarCurvas`, `dataRecebimentoEsperada`, `aplicarCenarioCurva`, `inadimplenciaPonderada`, `prazoMedioPonderado`).

- [ ] **Step 1: Adicionar tipos + helpers de aging no topo do engine**

Inserir, após o type `Config` (perto da linha 119), os tipos e constantes do bloco "Tipos compartilhados" (Faixa, CurvaFaixa, FAIXAS, LAG_MAX, CURVA_DEFAULT) e as funções `mediaPonderada`, `mediana`, `faixaAging`, `calibrarCurvas`, `dataRecebimentoEsperada`, `aplicarCenarioCurva`, `inadimplenciaPonderada`, `prazoMedioPonderado` — copiadas EXATAMENTE do `aging-helpers.ts` (mesma assinatura e corpo). `daysBetween` e `addDays` já existem no engine; não duplicar (usar os existentes).

- [ ] **Step 2: `carregarDados` — calibrar curvas uma vez por empresa**

Após carregar `crs`, calcular e anexar ao `DadosBase`:
```ts
// Onda 2: curvas de aging calibradas por exposição (últimos 12m)
const hojeIso = new Date().toISOString().slice(0, 10);
const curvas_aging = calibrarCurvas(
  crs.map(c => ({
    valor_documento: c.valor_documento, valor_recebido: c.valor_recebido, saldo: c.saldo,
    data_vencimento: c.data_vencimento, data_recebimento: c.data_recebimento, status_titulo: c.status_titulo,
  })),
  hojeIso,
);
```
Adicionar `curvas_aging: Record<Faixa, CurvaFaixa>` ao type `DadosBase` e ao objeto retornado.

- [ ] **Step 3: `gerarSemanas` — alocação por aging + ponte de horizonte**

Substituir o loop de CR (que hoje coloca `cr.saldo × (1 − inadimplencia_pct/100)` na semana do vencimento) por: para cada CR aberto com `data_vencimento`, calcular `diasAtraso`, `faixa = faixaAging(diasAtraso)`, `curva = curvaCenario[faixa]` (curva já com cenário aplicado — ver Step 4), `valor = cr.saldo × curva.taxa_recebimento`, `dataEsp = dataRecebimentoEsperada({ data_vencimento, hoje, faixa, lag_dias_faixa: curva.lag_dias })`. Se `dataEsp` cair dentro de `[semanaInicio, semanaInicio+horizon*7)` → alocar na semana correspondente. Senão → acumular em `apos_horizonte += valor`. A parte não-recebível esperada (`cr.saldo × (1 − taxa)`) acumula em `ar_impaired`. Retornar `apos_horizonte` e `ar_impaired` junto das semanas.

- [ ] **Step 4: `aplicarCenario` — curvas por cenário com clamp**

`aplicarCenario` passa a também devolver `curvas` ajustadas: para cada faixa, `aplicarCenarioCurva(dados.curvas_aging[faixa], faixa, deltasDoCenario)`. No `realista`, deltas = 0 (curva calibrada pura). Os deltas vêm de `config.overrides_cenario[cenario]` (já existem).

- [ ] **Step 5: `calcularIndicadores` — PMR/PMP ponderado + inadimplência ponderada**

PMR: `prazoMedioPonderado(crsLiquidados.map(c => ({ dias: daysBetween(c.data_recebimento!, c.data_emissao!), valor: c.valor_recebido })))`. PMP idem com pagamentos. Inadimplência: `inadimplenciaPonderada(crsAbertos.map(c => ({ saldo: c.saldo, faixa: faixaAging(daysBetween(hoje, c.data_vencimento!)) })), dados.curvas_aging)` — substitui `taxas.inadimplencia_observada_pct` no campo `inadimplencia_pct`.

- [ ] **Step 6: `calcularNCG` — guard de folha por janela**

No PCO: se houver CP de categoria de folha (categoria_codigo de folha — usar o mesmo critério de `is_folha`/categoria já disponível) com `data_vencimento` na janela de 30 dias, NÃO somar o `folha_30d` de eventos recorrentes em cima — usar o maior dos dois (ERP vence). Documentar inline.

- [ ] **Step 7: Persistir curvas em `premissas` + re-deploy**

No `calcular`, incluir `curvas_aging` (e `apos_horizonte`, `ar_impaired`) no objeto `premissas`/retorno. Entregar prompt pro chat do Lovable re-deployar `fin-cashflow-engine` lendo o arquivo do repo (verbatim). Confirmar Active.

---

## Task 7: Frontend types + UI

**Files:**
- Modify: `src/hooks/useCashflowProjection.ts`
- Modify: `src/components/financeiro/cashflow/Fluxo13Semanas.tsx`

- [ ] **Step 1: Type da resposta**

Em `CashflowResult`, adicionar:
```ts
  apos_horizonte?: number;
  ar_impaired?: number;
  curvas_aging?: Record<string, { taxa_recebimento: number; lag_dias: number; confianca: string }>;
```

- [ ] **Step 2: UI — linha após-horizonte + curva**

Em `Fluxo13Semanas.tsx`, ler `data.apos_horizonte` / `data.ar_impaired` e mostrar um rodapé/card: "Esperado após 13 semanas: R$ X · AR impaired (perda esperada): R$ Y". Adicionar uma mini-tabela das `curvas_aging` (faixa · taxa% · lag dias · confiança), com aviso quando alguma faixa estiver com `confianca: 'baixa'` ("curva estimada por default — pouca amostra").

- [ ] **Step 3: Build**

Run: `bun run build:dev`
Expected: sem erro de tipo.

---

## Task 8: Docs + validação E2E

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md`

- [ ] **Step 1: Doc seção Onda 2**

Adicionar (após a seção Onda 1) a seção "Onda 2 — Timing da projeção 13s" explicando: curvas por aging calibradas por exposição (sem viés), vencidos reagendados, recebimento fora de 13s vai pra ponte "após horizonte / AR impaired", +90 com recuperação/perda, cenários com clamp, PMR/PMP ponderado, inadimplência como taxa de perda ponderada, guard de folha. Regra de ouro: "ainda direcional até segmentação por cliente/instrumento + overrides manuais de tesouraria (deferidos)".

- [ ] **Step 2: Suíte + lint**

Run: `bun run test` → 100% verde. `bunx eslint <arquivos da Onda 2>` → zero erro novo.

- [ ] **Step 3: Validação funcional (pós-deploy, founder)**

Numa empresa com CR vencido: confirmar que (a) vencidos não somem mais (aparecem reagendados ou na ponte), (b) os 3 cenários geram curvas de caixa diferentes no timing, (c) curva de aging + confiança aparecem na UI, (d) PMR reflete os títulos grandes (ponderado).

---

## Self-Review (feito)

**1. Cobertura do spec:** aging buckets (T1), calibração por exposição (T3), +90 recuperação/perda — exposição/pago/aberto por faixa habilitam o split (T3+T6.3), lag ponderado+mediana (T2/T3), placement+ponte horizonte (T6.3), cenário com clamp (T4/T6.4), inadimplência ponderada (T5/T6.5), PMR/PMP ponderado (T5/T6.5), guard de folha (T6.6), confiança por R$+concentração (T3), UI (T7), docs (T8). ✅

**2. Placeholders:** nenhum TBD; todo passo de código tem código. T6.6 (guard folha) referencia o critério `is_folha`/categoria existente — o implementer confirma o campo lendo o engine; descrito o suficiente. ✅

**3. Consistência de tipos:** `Faixa`, `CurvaFaixa`, `CURVA_DEFAULT`, `LAG_MAX`, `FAIXAS` definidos em T1 e reusados idênticos em T3/T4/T5/T6. `calibrarCurvas`/`dataRecebimentoEsperada`/`aplicarCenarioCurva`/`inadimplenciaPonderada`/`prazoMedioPonderado` — mesma assinatura no helper (T1-5) e no espelho do engine (T6). ✅

**Nota:** o "+90 recuperação dentro vs após horizonte" emerge naturalmente da combinação placement (T6.3, dataEsp dentro/fora de 13s) + taxa (recuperação) + (1−taxa) (perda → ar_impaired). Não há função dedicada — é a consequência da alocação. Documentado em T6.3.
