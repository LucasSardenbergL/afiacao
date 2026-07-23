# Degradação honesta no dashboard financeiro (PR-A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o dashboard financeiro degradar honestamente sob falha de consulta — dizer "indisponível" (sem dado) ou marcar "desatualizado" (dado velho) em vez de exibir R$ 0,00 ou caixa antigo como se fossem atuais.

**Architecture:** Três estados por dataset (`ok`/`stale`/`unavailable`), derivados no dashboard a partir de erros por-dataset expostos pelo hook. O service para de engolir o erro do aging; os componentes ganham props aditivas de status. Padrão reusado verbatim do #1550 (`IntelligenceManagerialTab`).

**Tech Stack:** React 18 + TS 5.8 strict, vitest + @testing-library/react (`renderHook`/`render`), Supabase client mockado via `vi.mock`.

## Global Constraints

- **Idioma pt-BR** em todo código, comentário, mensagem de UI e commit.
- **Money-path §2/§7:** ausente ≠ zero; falha → último dado bom + aviso de stale; sem cache → "indisponível", **nunca** zero, **nunca** skeleton eterno.
- **Aditivo:** props novas são opcionais com default que preserva o comportamento atual de quem já chama.
- **Status colors:** `text-status-error`/`text-status-warning`/`text-muted-foreground` — nunca `text-red-600` etc.
- **Toast:** só `sonner` (não usado aqui, mas vale se surgir).
- **Falsificação (§31/§37):** para cada guard, sabotar e exigir vermelho conferindo **contagem e nomes** dos testes que falham; baseline verde com árvore limpa antes de cada rodada; ancorar asserção em string **ASCII exclusiva do ramo**. Baseline atual do escopo: `src/components/financeiro/dashboard` + `src/services/__tests__` = **15 files, 80 tests, verde**.
- **Gates antes de cada commit:** o teste da própria task verde. Gate final (Task 7): `heavy bun run typecheck` · `heavy bun run test` · `bun lint`, todos verdes — não prever o verde de gate que ainda não fechou.
- **Sem migration/edge:** mudança só-`src/`. Deploy = Publish do frontend no Lovable.

---

## File Structure

- **Create** `src/components/financeiro/dashboard/dataStatus.ts` — helper puro `statusFrom` + tipo `DataStatus`.
- **Create** `src/components/financeiro/dashboard/__tests__/dataStatus.test.ts`.
- **Modify** `src/services/financeiroService.ts` — `getAgingReceber`/`getAgingPagar` lançam; `EMPTY_AGING` vira `export`.
- **Create** `src/services/__tests__/getAging.test.ts`.
- **Modify** `src/components/financeiro/cockpit/useFinanceiroCockpit.ts:69` — `.catch(() => EMPTY_AGING)` anti-regressão.
- **Create** `src/components/financeiro/cockpit/__tests__/useFinanceiroCockpit.antirregressao.test.ts`.
- **Modify** `src/hooks/useFinanceiro.ts` — `errors` por dataset; `error` só para ações de sync.
- **Create** `src/hooks/__tests__/useFinanceiro.test.tsx`.
- **Modify** `src/components/financeiro/dashboard/FluxoCaixaTab.tsx` — prop `status`; coluna "Acumulado" honesta quando `saldoCC == null`.
- **Modify** `src/components/financeiro/dashboard/__tests__/FluxoCaixaTab.test.tsx` — casos novos.
- **Modify** `src/components/financeiro/dashboard/KpiCard.tsx` — prop `unavailable`.
- **Modify** `src/components/financeiro/dashboard/__tests__/KpiCard.test.tsx` — caso novo.
- **Modify** `src/components/financeiro/dashboard/AgingCard.tsx` — prop `status` (não skeleton-eterno sob falha).
- **Modify** `src/components/financeiro/dashboard/VisaoGeralTab.tsx` — props `resumoStatus`/`agingStatus`; banners; KPIs "—".
- **Modify** `src/components/financeiro/dashboard/__tests__/VisaoGeralTab.test.tsx` — casos novos.
- **Modify** `src/pages/FinanceiroDashboard.tsx` — deriva `statusFrom` e passa aos filhos.

Registro de módulo: **sem mudança** (o glob `src/components/financeiro/**` já cobre os arquivos novos; `src/hooks/useFinanceiro*.ts` cobre o hook e seu teste vizinho).

---

### Task 1: Helper puro `dataStatus`

**Files:**
- Create: `src/components/financeiro/dashboard/dataStatus.ts`
- Test: `src/components/financeiro/dashboard/__tests__/dataStatus.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `type DataStatus = 'ok' | 'stale' | 'unavailable'` e `function statusFrom(hasError: boolean, hasData: boolean): DataStatus`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/components/financeiro/dashboard/__tests__/dataStatus.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { statusFrom } from '../dataStatus';

describe('statusFrom — três estados de honestidade (money-path §7)', () => {
  it('sem erro → ok (independe de ter dado)', () => {
    expect(statusFrom(false, true)).toBe('ok');
    expect(statusFrom(false, false)).toBe('ok');
  });

  it('erro COM dado anterior → stale (mostra o velho + aviso)', () => {
    expect(statusFrom(true, true)).toBe('stale');
  });

  it('erro SEM dado → unavailable (mostra "—", nunca zero)', () => {
    expect(statusFrom(true, false)).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `heavy bun run test -- src/components/financeiro/dashboard/__tests__/dataStatus.test.ts`
Expected: FAIL — `Cannot find module '../dataStatus'` (ou `statusFrom is not a function`).

- [ ] **Step 3: Implementar o helper**

Criar `src/components/financeiro/dashboard/dataStatus.ts`:

```ts
// Estado de honestidade de um dataset do dashboard financeiro (money-path §7).
// 'ok' → renderiza normal. 'stale' → tem dado anterior + houve erro no re-load:
// mostra o último dado bom com aviso. 'unavailable' → erro sem dado: mostra "—",
// nunca zero, nunca skeleton eterno.
export type DataStatus = 'ok' | 'stale' | 'unavailable';

export function statusFrom(hasError: boolean, hasData: boolean): DataStatus {
  if (!hasError) return 'ok';
  return hasData ? 'stale' : 'unavailable';
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `heavy bun run test -- src/components/financeiro/dashboard/__tests__/dataStatus.test.ts`
Expected: PASS — 3 testes verdes.

- [ ] **Step 5: Falsificar**

Editar `dataStatus.ts` temporariamente: `return hasData ? 'stale' : 'unavailable';` → `return 'ok';`. Rodar o teste.
Expected: 2 vermelhos (`erro COM dado → stale` e `erro SEM dado → unavailable`), `sem erro → ok` verde. Reverter a sabotagem e reconfirmar 3 verdes.

- [ ] **Step 6: Commit**

```bash
git add src/components/financeiro/dashboard/dataStatus.ts src/components/financeiro/dashboard/__tests__/dataStatus.test.ts
git commit -m "feat(financeiro): helper statusFrom — ok/stale/unavailable por dataset [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Service — aging lança em erro; `EMPTY_AGING` exportado

**Files:**
- Modify: `src/services/financeiroService.ts` (`EMPTY_AGING` em `:123`; `getAgingReceber` `:302-310`; `getAgingPagar` `:312-320`)
- Test: `src/services/__tests__/getAging.test.ts`

**Interfaces:**
- Consumes: `AgingData`, `consolidateAging`, `pickAgingForCompany`, `EMPTY_AGING` (todos já no módulo).
- Produces: `export const EMPTY_AGING: AgingData`; `getAgingReceber`/`getAgingPagar` passam a **rejeitar** (`throw`) em `{ error }` e a retornar `EMPTY_AGING` em `{ data: [] }` (vazio genuíno).

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/services/__tests__/getAging.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// Mock mínimo do PostgREST: getAging faz apenas .from(...).select('*').
const estado = vi.hoisted(() => ({
  resultado: { data: null as unknown, error: null as unknown },
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => Promise.resolve(estado.resultado) }) },
}));

import { getAgingReceber, getAgingPagar, EMPTY_AGING } from '@/services/financeiroService';

// Linha da view com todas as colunas de AgingData (o consolidate lê AGING_KEYS).
const linha = (company: string) => ({
  company,
  a_vencer_qtd: 1, a_vencer_valor: 100,
  vencido_1_30_qtd: 0, vencido_1_30_valor: 0,
  vencido_31_60_qtd: 0, vencido_31_60_valor: 0,
  vencido_61_90_qtd: 0, vencido_61_90_valor: 0,
  vencido_90_plus_qtd: 2, vencido_90_plus_valor: 800,
});

beforeEach(() => { estado.resultado = { data: null, error: null }; });

describe('getAgingReceber/Pagar — falha de consulta NÃO vira aging zerado (money-path §2)', () => {
  it('getAgingReceber LANCA em erro de consulta (era swallow → EMPTY_AGING falso)', async () => {
    estado.resultado = { data: null, error: { message: 'statement timeout' } };
    await expect(getAgingReceber('all')).rejects.toThrow(/aging receb/i);
  });

  it('getAgingPagar LANCA em erro de consulta', async () => {
    estado.resultado = { data: null, error: { message: 'RLS negou' } };
    await expect(getAgingPagar('all')).rejects.toThrow(/aging pag/i);
  });

  it('vazio GENUINO (data:[]) segue virando EMPTY_AGING — zero REAL, nao fabricado', async () => {
    estado.resultado = { data: [], error: null };
    expect(await getAgingReceber('all')).toEqual(EMPTY_AGING);
  });

  it('consolida as linhas reais quando ha dado', async () => {
    estado.resultado = { data: [linha('oben'), linha('colacor')], error: null };
    const r = await getAgingReceber('all');
    expect(r.a_vencer_valor).toBe(200);
    expect(r.vencido_90_plus_valor).toBe(1600);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `heavy bun run test -- src/services/__tests__/getAging.test.ts`
Expected: FAIL — os dois casos `LANCA` falham (hoje o service devolve `EMPTY_AGING` sem lançar); pode falhar também o import de `EMPTY_AGING` (ainda não exportado).

- [ ] **Step 3: Implementar — exportar `EMPTY_AGING` e fazer o aging lançar**

Em `src/services/financeiroService.ts`, mudar a declaração de `EMPTY_AGING` (linha ~123) de `const EMPTY_AGING` para:

```ts
export const EMPTY_AGING: AgingData = {
```

(apenas prefixar `export`; o corpo do objeto não muda).

Substituir `getAgingReceber` (linhas ~302-310) por:

```ts
export async function getAgingReceber(company: Company | 'all'): Promise<AgingData> {
  const { data, error } = await supabase
    .from("fin_aging_receber")
    .select("*");

  // Erro LANCA (era swallow → EMPTY_AGING): aging R$0 falso apaga o sensor de
  // inadimplencia (o alerta >90d nunca dispara). Vazio genuino (data:[]) segue
  // virando EMPTY_AGING = zero REAL.
  if (error) throw new Error(`Falha ao carregar aging recebíveis: ${error.message}`);
  const rows = data ?? [];
  if (company === 'all') return consolidateAging(rows);
  return pickAgingForCompany(rows, company);
}
```

Substituir `getAgingPagar` (linhas ~312-320) por:

```ts
export async function getAgingPagar(company: Company | 'all'): Promise<AgingData> {
  const { data, error } = await supabase
    .from("fin_aging_pagar")
    .select("*");

  if (error) throw new Error(`Falha ao carregar aging pagáveis: ${error.message}`);
  const rows = data ?? [];
  if (company === 'all') return consolidateAging(rows);
  return pickAgingForCompany(rows, company);
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `heavy bun run test -- src/services/__tests__/getAging.test.ts`
Expected: PASS — 4 testes verdes.

- [ ] **Step 5: Falsificar**

Em `getAgingReceber`, reverter o guard: trocar `if (error) throw new Error(...)` por `if (error || !data) return { ...EMPTY_AGING };`. Rodar o teste.
Expected: 1 vermelho — `getAgingReceber LANCA em erro de consulta` (os demais seguem verdes; `getAgingPagar LANCA` continua verde porque não foi sabotado — confirma que o assert mira o ramo certo). Reverter e reconfirmar 4 verdes.

- [ ] **Step 6: Commit**

```bash
git add src/services/financeiroService.ts src/services/__tests__/getAging.test.ts
git commit -m "fix(financeiro): getAging para de engolir erro — aging R\$0 falso apagava o alerta de inadimplencia [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Cockpit — `.catch(() => EMPTY_AGING)` anti-regressão

**Files:**
- Modify: `src/components/financeiro/cockpit/useFinanceiroCockpit.ts` (import `:8`; chamada `:69`)
- Test: `src/components/financeiro/cockpit/__tests__/useFinanceiroCockpit.antirregressao.test.ts`

**Interfaces:**
- Consumes: `EMPTY_AGING` (Task 2), `AgingData`.
- Produces: comportamento — falha de aging degrada só o aging, **não** derruba o cockpit inteiro (resumo/DRE/inadimplentes sobrevivem).

**Contexto:** hoje `getAgingReceber('all')` (`:69`) é a única das 5 chamadas do `Promise.all` (`:62`) sem `.catch()`. Como Task 2 fez o service lançar, sem este `.catch` uma falha de aging rejeita o `Promise.all` → cai no catch de topo (`:134`) → `COCKPIT_VAZIO` (regressão: hoje só o aging zera).

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/components/financeiro/cockpit/__tests__/useFinanceiroCockpit.antirregressao.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Falha de aging NAO pode derrubar o cockpit inteiro: resumo/DRE/inadimplentes
// vem de fontes independentes. Sem o .catch no getAgingReceber, o Promise.all
// rejeita e tudo zera (COCKPIT_VAZIO). Este teste trava essa regressao.
const svc = vi.hoisted(() => ({
  getResumoFinanceiro: vi.fn(),
  getAgingReceber: vi.fn(),
  getDRE: vi.fn(),
  getTopInadimplentes: vi.fn(),
  EMPTY_AGING: {
    a_vencer_qtd: 0, a_vencer_valor: 0,
    vencido_1_30_qtd: 0, vencido_1_30_valor: 0,
    vencido_31_60_qtd: 0, vencido_31_60_valor: 0,
    vencido_61_90_qtd: 0, vencido_61_90_valor: 0,
    vencido_90_plus_qtd: 0, vencido_90_plus_valor: 0,
  },
}));
vi.mock('@/services/financeiroService', () => svc);

const v2 = vi.hoisted(() => ({
  getProjecaoSnapshotsCockpit: vi.fn(),
  getBalancoInputs: vi.fn(),
  getNcgNaJanela: vi.fn(),
}));
vi.mock('@/services/financeiroV2Service', () => v2);

// supabase.from(...).select().eq().eq().eq().maybeSingle() → {data:null}; rpc → {data:[]}
vi.mock('@/integrations/supabase/client', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return { supabase: { from: () => chain, rpc: () => Promise.resolve({ data: [], error: null }) } };
});

vi.mock('@/hooks/useFinanceiroRegime', () => ({ useFinanceiroRegime: () => ({ regime: 'competencia' }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { useFinanceiroCockpit } from '../useFinanceiroCockpit';

const resumoOben = {
  contas_correntes: [], saldo_total_cc: 1234,
  total_a_receber: 10, total_a_pagar: 5,
  total_vencido_receber: 0, total_vencido_pagar: 0, posicao_liquida: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.getResumoFinanceiro.mockResolvedValue({ oben: resumoOben });
  svc.getDRE.mockResolvedValue([]);
  svc.getTopInadimplentes.mockResolvedValue([]);
  v2.getProjecaoSnapshotsCockpit.mockResolvedValue([]);
  v2.getBalancoInputs.mockResolvedValue({});
  v2.getNcgNaJanela.mockResolvedValue([]);
});

describe('useFinanceiroCockpit — falha de aging nao zera o cockpit inteiro', () => {
  it('aging rejeitado preserva o resumo (nao vira COCKPIT_VAZIO)', async () => {
    svc.getAgingReceber.mockRejectedValue(new Error('statement timeout'));

    const { result } = renderHook(() => useFinanceiroCockpit());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resumo.oben?.saldo_total_cc).toBe(1234);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `heavy bun run test -- src/components/financeiro/cockpit/__tests__/useFinanceiroCockpit.antirregressao.test.ts`
Expected: FAIL — `resumo.oben` é `undefined` (aging rejeitado derrubou o `Promise.all` → `resumo` ficou `{}`).

- [ ] **Step 3: Implementar o `.catch`**

Em `src/components/financeiro/cockpit/useFinanceiroCockpit.ts`, no import da linha 8, acrescentar `EMPTY_AGING`:

```ts
import { getResumoFinanceiro, getAgingReceber, getDRE, getTopInadimplentes, EMPTY_AGING, type FinResumo, type AgingData, type FinDRE } from '@/services/financeiroService';
```

Substituir a linha 69 (`getAgingReceber('all'),`) por:

```ts
        // PR-A: getAgingReceber agora LANCA em erro (Task 2). Este .catch preserva
        // o comportamento pre-existente do cockpit — falha de aging degrada SO o
        // aging, sem derrubar resumo/DRE/inadimplentes. O tratamento honesto (banner
        // de indisponibilidade) vem no PR-B.
        getAgingReceber('all').catch((e): AgingData => {
          logger.warn('Aging (cockpit) indisponível', { error: e instanceof Error ? e.message : String(e) });
          return EMPTY_AGING;
        }),
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `heavy bun run test -- src/components/financeiro/cockpit/__tests__/useFinanceiroCockpit.antirregressao.test.ts`
Expected: PASS — 1 teste verde.

- [ ] **Step 5: Falsificar**

Remover o `.catch(...)` (voltar para `getAgingReceber('all'),`). Rodar o teste.
Expected: 1 vermelho — `aging rejeitado preserva o resumo`. Reverter e reconfirmar verde.

- [ ] **Step 6: Commit**

```bash
git add src/components/financeiro/cockpit/useFinanceiroCockpit.ts src/components/financeiro/cockpit/__tests__/useFinanceiroCockpit.antirregressao.test.ts
git commit -m "fix(financeiro): cockpit nao desaba quando aging falha — .catch preserva resumo/DRE [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Hook `useFinanceiro` — `errors` por dataset; `error` só para sync

**Files:**
- Modify: `src/hooks/useFinanceiro.ts` (estado `:28`; loaders `:61-171`; retorno `:300-335`)
- Test: `src/hooks/__tests__/useFinanceiro.test.tsx`

**Interfaces:**
- Consumes: os getters do service (mockados no teste).
- Produces: no retorno do hook, `errors: Partial<Record<DatasetKey, string>>` (novo) além do `error: string | null` já existente (agora setado só por `syncAll`/`syncSpecific`/`calcularDRE`/`calcularDREAnual`). `type DatasetKey = 'resumo' | 'contasPagar' | 'contasReceber' | 'aging' | 'dre' | 'fluxoCaixa' | 'inadimplentes'`. Cada `loadX` limpa a própria key em sucesso e a seta em falha, **sem** limpar o `data` state.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/hooks/__tests__/useFinanceiro.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { FluxoCaixaDiario } from '@/services/financeiroService';

// Falha de LOAD por dataset: seta errors[key], PRESERVA o dado anterior (stale),
// e sucesso limpa SO a propria key (nao gruda entre abas — o defeito D2).
const svc = vi.hoisted(() => ({
  triggerFinanceiroSync: vi.fn(),
  getResumoFinanceiro: vi.fn(),
  getContasPagar: vi.fn(),
  getContasReceber: vi.fn(),
  getAgingReceber: vi.fn(),
  getAgingPagar: vi.fn(),
  getDRE: vi.fn(),
  getFluxoCaixa: vi.fn(),
  getTopInadimplentes: vi.fn(),
  getLastSyncTime: vi.fn(),
}));
vi.mock('@/services/financeiroService', () => svc);

import { useFinanceiro } from '../useFinanceiro';

const dia = (over: Partial<FluxoCaixaDiario> = {}): FluxoCaixaDiario => ({
  data: '2026-01-05', entradas_previstas: 0, entradas_realizadas: 1000,
  saidas_previstas: 0, saidas_realizadas: 0, saldo_previsto: 0, saldo_realizado: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  svc.getLastSyncTime.mockResolvedValue(null);
  svc.getResumoFinanceiro.mockResolvedValue({});
  svc.getAgingReceber.mockResolvedValue({});
  svc.getAgingPagar.mockResolvedValue({});
  svc.getFluxoCaixa.mockResolvedValue([]);
});

describe('useFinanceiro — erro por dataset, stale preservado (money-path §7)', () => {
  it('loadFluxoCaixa: falha seta errors.fluxoCaixa e PRESERVA o fluxo anterior (stale)', async () => {
    svc.getFluxoCaixa.mockResolvedValueOnce([dia()]);
    const { result } = renderHook(() => useFinanceiro('all'));

    await act(async () => { await result.current.loadFluxoCaixa('2026-01-01', '2026-12-31'); });
    expect(result.current.fluxoCaixa).toHaveLength(1);
    expect(result.current.errors.fluxoCaixa).toBeUndefined();

    svc.getFluxoCaixa.mockRejectedValueOnce(new Error('statement timeout 57014'));
    await act(async () => { await result.current.loadFluxoCaixa('2026-01-01', '2026-12-31'); });

    expect(result.current.errors.fluxoCaixa).toMatch(/timeout/);
    expect(result.current.fluxoCaixa).toHaveLength(1); // dado anterior preservado → stale
  });

  it('sucesso LIMPA a propria key de erro', async () => {
    svc.getFluxoCaixa.mockRejectedValueOnce(new Error('falhou'));
    const { result } = renderHook(() => useFinanceiro('all'));
    await act(async () => { await result.current.loadFluxoCaixa('2026-01-01', '2026-12-31'); });
    expect(result.current.errors.fluxoCaixa).toBeDefined();

    svc.getFluxoCaixa.mockResolvedValueOnce([dia()]);
    await act(async () => { await result.current.loadFluxoCaixa('2026-01-01', '2026-12-31'); });
    expect(result.current.errors.fluxoCaixa).toBeUndefined();
  });

  it('erro num dataset NAO gruda em outro (defeito D2)', async () => {
    svc.getResumoFinanceiro.mockRejectedValueOnce(new Error('resumo caiu'));
    svc.getFluxoCaixa.mockResolvedValueOnce([dia()]);
    const { result } = renderHook(() => useFinanceiro('all'));

    await act(async () => { await result.current.loadResumo(); });
    await act(async () => { await result.current.loadFluxoCaixa('2026-01-01', '2026-12-31'); });

    expect(result.current.errors.resumo).toBeDefined();
    expect(result.current.errors.fluxoCaixa).toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `heavy bun run test -- src/hooks/__tests__/useFinanceiro.test.tsx`
Expected: FAIL — `result.current.errors` é `undefined` (o hook ainda não expõe `errors`).

- [ ] **Step 3: Implementar — estado, helpers e loaders**

Em `src/hooks/useFinanceiro.ts`:

**(a)** Após a linha `export type FinanceiroView = 'all' | Company;` (linha 22), adicionar:

```ts
export type DatasetKey =
  | 'resumo' | 'contasPagar' | 'contasReceber'
  | 'aging' | 'dre' | 'fluxoCaixa' | 'inadimplentes';
```

**(b)** Trocar o estado de erro (linha 28) por dois canais:

```ts
  // `error`: falha de ACAO (sync/recalculo) — banner global do topo.
  const [error, setError] = useState<string | null>(null);
  // `errors`: falha de LOAD por dataset — a UI deriva stale/unavailable localizado.
  const [errors, setErrors] = useState<Partial<Record<DatasetKey, string>>>({});
```

**(c)** Logo após os `useState` de dados (após a linha 41, `const [lastSync, ...]`), adicionar os helpers:

```ts
  const setDatasetError = useCallback((key: DatasetKey, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setErrors((prev) => ({ ...prev, [key]: msg }));
  }, []);
  const clearDatasetError = useCallback((key: DatasetKey) => {
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);
```

**(d)** Em cada loader, trocar `setError(e...)` do `catch` por `setDatasetError('<key>', e)` e adicionar `clearDatasetError('<key>')` no fim do `try` (após os setters de dado). NÃO limpar o `data` state. As keys por loader:

- `loadResumo` (`:61`): sucesso → após `setLastSync(syncTime);` add `clearDatasetError('resumo');`; catch → `setDatasetError('resumo', e);`. Deps do `useCallback`: `[view, clearDatasetError, setDatasetError]`.
- `loadContasPagar` (`:80`): key `'contasPagar'`; sucesso após `setContasPagar(data);`. Deps `[view, clearDatasetError, setDatasetError]`.
- `loadContasReceber` (`:97`): key `'contasReceber'`; após `setContasReceber(data);`. Deps idem.
- `loadAging` (`:114`): key `'aging'`; após `setAgingPagar(ap);`. Deps idem.
- `loadDRE` (`:128`): key `'dre'`; após o `setDre(...)` de cada ramo (colocar `clearDatasetError('dre');` uma vez, após o `if/else`). Deps `[view, clearDatasetError, setDatasetError]`.
- `loadFluxoCaixa` (`:150`): key `'fluxoCaixa'`; após `setFluxoCaixa(data);`. Deps idem.
- `loadInadimplentes` (`:163`): key `'inadimplentes'`; após `setInadimplentes(data);`. Deps idem.

Exemplo concreto — `loadFluxoCaixa` fica:

```ts
  const loadFluxoCaixa = useCallback(async (dataInicio: string, dataFim: string) => {
    try {
      setLoading(true);
      const company = view === 'all' ? 'all' : view as Company;
      const data = await getFluxoCaixa(company, dataInicio, dataFim);
      setFluxoCaixa(data);
      clearDatasetError('fluxoCaixa');
    } catch (e) {
      setDatasetError('fluxoCaixa', e);
    } finally {
      setLoading(false);
    }
  }, [view, clearDatasetError, setDatasetError]);
```

E `loadResumo` fica (mostrando o catch trocado):

```ts
    } catch (e) {
      setDatasetError('resumo', e);
    } finally {
      setLoading(false);
    }
  }, [view, clearDatasetError, setDatasetError]);
```

**(e)** Os action handlers `syncAll` (`:174`), `calcularDRE` (`:191`), `calcularDREAnual` (`:206`), `syncSpecific` (`:221`) **NÃO mudam** — seguem usando `setError(...)`. (`syncAll`/`syncSpecific` já fazem `setError(null)` no início.)

**(f)** No objeto de retorno, adicionar `errors` ao lado de `error` (linha ~306):

```ts
    error,
    errors,
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `heavy bun run test -- src/hooks/__tests__/useFinanceiro.test.tsx`
Expected: PASS — 3 testes verdes.

- [ ] **Step 5: Falsificar**

Duas sabotagens independentes (o teste tem duas asserções distintas — preservação e isolamento):
1. No `catch` de `loadFluxoCaixa`, adicionar `setFluxoCaixa([]);` antes do `setDatasetError`. Rodar → vermelho em `falha ... PRESERVA o fluxo anterior` (o array vira 0). Reverter.
2. Trocar o corpo de `clearDatasetError` por um no-op (`setErrors((prev) => prev);`). Rodar → vermelho em `sucesso LIMPA a propria key`. Reverter.

Antes de cada rodada, confirmar o **total** de testes do arquivo (3) no log — se vier `Syntax Error`/denominador diferente, a sabotagem é inválida (§37). Reconfirmar 3 verdes ao fim.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useFinanceiro.ts src/hooks/__tests__/useFinanceiro.test.tsx
git commit -m "fix(financeiro): erro por dataset no useFinanceiro — banner nao gruda, stale preservado [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `FluxoCaixaTab` — prop `status`; coluna "Acumulado" honesta

**Files:**
- Modify: `src/components/financeiro/dashboard/FluxoCaixaTab.tsx`
- Test: `src/components/financeiro/dashboard/__tests__/FluxoCaixaTab.test.tsx`

**Interfaces:**
- Consumes: `DataStatus` (Task 1).
- Produces: `FluxoCaixaTab` aceita `status?: DataStatus` (default `'ok'`). `unavailable` → banner "indisponível" no lugar do empty-state de sync; `stale` → gráfico + aviso; `saldoCC == null` → coluna "Acumulado" mostra "—".

- [ ] **Step 1: Escrever os testes que falham**

Em `src/components/financeiro/dashboard/__tests__/FluxoCaixaTab.test.tsx`, adicionar ao final (antes do último `});` de fechamento do arquivo, como novo `describe`):

```tsx
describe('FluxoCaixaTab — honestidade sob falha (money-path §7)', () => {
  it('status=unavailable → "indisponivel", NAO "Sincronize"', () => {
    render(<FluxoCaixaTab data={[]} loading={false} status="unavailable" />);
    expect(screen.getByRole('alert').textContent).toMatch(/indispon/i);
    expect(screen.queryByText(/Sincronize os dados primeiro/)).toBeNull();
  });

  it('status=ok + vazio → mantem "Sincronize" (vazio genuino, nao falha)', () => {
    render(<FluxoCaixaTab data={[]} loading={false} status="ok" />);
    expect(screen.getByText(/Nenhum dado de fluxo de caixa/)).toBeTruthy();
  });

  it('status=stale → mostra o grafico + aviso de desatualizado', () => {
    render(<FluxoCaixaTab data={days} loading={false} saldoCC={5000} status="stale" />);
    expect(screen.getByText('Fluxo de Caixa Semanal')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/desatualiz/i);
  });

  it('saldoCC ausente → coluna Acumulado nao fabrica (mostra "—")', () => {
    const { container } = render(<FluxoCaixaTab data={days} loading={false} />);
    // Sem saldoCC o KPI "Saldo CC Atual" nao aparece e o acumulado nao projeta de zero.
    expect(screen.queryByText('Saldo CC Atual')).toBeNull();
    expect(container.textContent).toMatch(/—/);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `heavy bun run test -- src/components/financeiro/dashboard/__tests__/FluxoCaixaTab.test.tsx`
Expected: FAIL — `status=unavailable` não acha `role="alert"` (prop ignorada); `saldoCC ausente` não acha "—".

- [ ] **Step 3: Implementar**

Em `src/components/financeiro/dashboard/FluxoCaixaTab.tsx`:

**(a)** Importar o tipo (após a linha 7, `import type { FluxoCaixaDiario } ...`):

```ts
import type { DataStatus } from '@/components/financeiro/dashboard/dataStatus';
```

**(b)** Assinatura (linha 9) — adicionar `status`:

```ts
export function FluxoCaixaTab({ data, loading, saldoCC, status = 'ok' }: { data: FluxoCaixaDiario[]; loading: boolean; saldoCC?: number; status?: DataStatus }) {
  if (loading) return <Skeleton className="h-60" />;
  if (status === 'unavailable') {
    return (
      <Card>
        <CardContent className="py-12 text-center text-status-error">
          <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p role="alert">Fluxo de caixa indisponível — não foi possível ler os dados. Não é ausência de movimento; é falha de leitura.</p>
        </CardContent>
      </Card>
    );
  }
  if (!data || data.length === 0) {
```

(o restante do empty-state "Sincronize" segue inalterado — agora só alcançado com `status !== 'unavailable'`, isto é, vazio genuíno.)

**(c)** Coluna "Acumulado" honesta — na linha 38, trocar:

```ts
  let acumulado = saldoCC || 0;
```

por:

```ts
  const acumuladoConhecido = saldoCC != null;
  let acumulado = saldoCC ?? 0;
```

E no render da coluna acumulado (linha ~112-114), trocar `{fmtCompact(w.acumulado)}` por:

```tsx
                <span className={`text-right text-[10px] ${w.acumulado >= 0 ? 'text-status-info' : 'text-status-error'}`}>
                  {acumuladoConhecido ? fmtCompact(w.acumulado) : '—'}
                </span>
```

**(d)** Banner de stale — logo após a abertura `return (` do caminho com dados (linha 61, `<div className="space-y-4">`), inserir como primeiro filho:

```tsx
      {status === 'stale' && (
        <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-2 text-xs text-status-warning">
          Mostrando o último dado carregado — a atualização falhou.
        </div>
      )}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `heavy bun run test -- src/components/financeiro/dashboard/__tests__/FluxoCaixaTab.test.tsx`
Expected: PASS — os 3 testes antigos + 4 novos verdes.

- [ ] **Step 5: Falsificar**

1. Remover o bloco `if (status === 'unavailable')`. Rodar → vermelho em `status=unavailable → "indisponivel"`. Reverter.
2. Trocar `acumuladoConhecido ? fmtCompact(w.acumulado) : '—'` por `fmtCompact(w.acumulado)`. Rodar → vermelho em `saldoCC ausente → ... "—"`. Reverter.

Confirmar o denominador (7) em cada rodada. Reconfirmar 7 verdes.

- [ ] **Step 6: Commit**

```bash
git add src/components/financeiro/dashboard/FluxoCaixaTab.tsx src/components/financeiro/dashboard/__tests__/FluxoCaixaTab.test.tsx
git commit -m "fix(financeiro): FluxoCaixaTab distingue vazio de falha; acumulado nao parte de zero [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `KpiCard`/`AgingCard`/`VisaoGeralTab` — "—" e banners sob falha

**Files:**
- Modify: `src/components/financeiro/dashboard/KpiCard.tsx`
- Modify: `src/components/financeiro/dashboard/__tests__/KpiCard.test.tsx`
- Modify: `src/components/financeiro/dashboard/AgingCard.tsx`
- Modify: `src/components/financeiro/dashboard/VisaoGeralTab.tsx`
- Modify: `src/components/financeiro/dashboard/__tests__/VisaoGeralTab.test.tsx`

**Interfaces:**
- Consumes: `DataStatus` (Task 1).
- Produces: `KpiCard` aceita `unavailable?: boolean` (default `false`) → renderiza "—". `AgingCard` aceita `status?: DataStatus` (default `'ok'`) → sob `unavailable` mostra "indisponível" em vez de skeleton. `VisaoGeralTab` aceita `resumoStatus?: DataStatus` e `agingStatus?: DataStatus` (default `'ok'`) → banners + KPIs/aging "—".

- [ ] **Step 1: Escrever os testes que falham**

Em `KpiCard.test.tsx`, adicionar novo `describe`:

```tsx
describe('KpiCard — unavailable mostra "—" (money-path §2)', () => {
  it('unavailable → "—", nao "R$ 0,00"', () => {
    render(<KpiCard title="A Receber" value={0} icon={Wallet} color="text-status-info" bgColor="bg-status-info-bg" unavailable />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText(/R\$/)).toBeNull();
  });
});
```

(Se `KpiCard.test.tsx` não importar `Wallet`/`render`/`screen`, adicionar no topo: `import { render, screen } from '@testing-library/react';` e `import { Wallet } from 'lucide-react';` — verificar os imports existentes antes.)

Em `VisaoGeralTab.test.tsx`, adicionar novo `describe`:

```tsx
describe('VisaoGeralTab — honestidade sob falha (money-path §7)', () => {
  it('resumoStatus=unavailable → banner de indisponibilidade e KPIs "—"', () => {
    renderWithClient(
      <VisaoGeralTab
        alerts={[]} activeResumo={null} resumo={{}} view="all"
        agingReceber={null} agingPagar={null} inadimplentes={[]}
        resumoStatus="unavailable"
      />
    );
    const avisos = screen.getAllByRole('alert');
    expect(avisos.some((a) => /indispon/i.test(a.textContent ?? ''))).toBe(true);
    // Os 4 KPIs de dinheiro nao podem exibir "R$ 0,00" sob falha.
    expect(screen.queryByText(/R\$\s*0,00/)).toBeNull();
  });

  it('agingStatus=unavailable → AgingCard nao fica em skeleton eterno', () => {
    const { container } = renderWithClient(
      <VisaoGeralTab
        alerts={[]} activeResumo={resumoCo} resumo={{ colacor: resumoCo }} view="all"
        agingReceber={null} agingPagar={null} inadimplentes={[]}
        agingStatus="unavailable"
      />
    );
    // Sem tratamento, AgingCard(null) renderiza <Skeleton> (animate-pulse) para sempre.
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `heavy bun run test -- src/components/financeiro/dashboard/__tests__/KpiCard.test.tsx src/components/financeiro/dashboard/__tests__/VisaoGeralTab.test.tsx`
Expected: FAIL — KpiCard ignora `unavailable`; VisaoGeralTab não aceita `resumoStatus`/`agingStatus`; AgingCard(null) ainda mostra skeleton.

- [ ] **Step 3: Implementar**

**(a) `KpiCard.tsx`** — assinatura (linha 7) adiciona `unavailable`; corpo mostra "—":

```tsx
export function KpiCard({ title, value, icon: Icon, color, bgColor, subtitle, subtitleColor, unavailable = false }: {
  title: string;
  value: number;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  subtitle?: string;
  subtitleColor?: string;
  unavailable?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className={`text-lg kpi-value mt-1 ${unavailable ? 'text-muted-foreground' : color}`}>
              {unavailable ? '—' : fmtCompact(value)}
            </p>
            {subtitle && !unavailable && (
              <p className={`text-xs mt-1 ${subtitleColor || 'text-muted-foreground'}`}>{subtitle}</p>
            )}
          </div>
          <div className={`p-2 rounded-lg ${bgColor}`}>
            <Icon className={`w-4 h-4 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

**(b) `AgingCard.tsx`** — importar `DataStatus`, adicionar `status`, e sob `unavailable` mostrar mensagem em vez de skeleton. Trocar a assinatura (linha 8) e o bloco `if (!data)`:

```tsx
import type { AgingData } from '@/services/financeiroService';
import type { DataStatus } from '@/components/financeiro/dashboard/dataStatus';

export function AgingCard({ title, data, status = 'ok' }: { title: string; data: AgingData | null; type: 'receber' | 'pagar'; status?: DataStatus }) {
  if (!data) return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {status === 'unavailable'
          ? <p role="alert" className="text-xs text-status-error py-6 text-center">Indisponível — não foi possível ler o aging.</p>
          : <Skeleton className="h-40" />}
      </CardContent>
    </Card>
  );
```

(o restante do componente não muda.)

**(c) `VisaoGeralTab.tsx`** — importar `DataStatus`, adicionar as duas props, banners, e propagar `unavailable`/`status`:

Import (após a linha 18, `import { DataHealthBanner } ...`):

```ts
import type { DataStatus } from '@/components/financeiro/dashboard/dataStatus';
```

Assinatura (linha 20-30) — adicionar `resumoStatus = 'ok'` e `agingStatus = 'ok'`:

```ts
export function VisaoGeralTab({
  alerts, activeResumo, resumo, view, agingReceber, agingPagar, inadimplentes,
  resumoStatus = 'ok', agingStatus = 'ok',
}: {
  alerts: FinAlert[];
  activeResumo: FinResumo | null;
  resumo: Record<string, FinResumo>;
  view: FinanceiroView;
  agingReceber: AgingData | null;
  agingPagar: AgingData | null;
  inadimplentes: { nome: string; cnpj: string; total_vencido: number; qtd_titulos: number }[];
  resumoStatus?: DataStatus;
  agingStatus?: DataStatus;
}) {
  const resumoIndisponivel = resumoStatus === 'unavailable';
```

Banners — logo após a abertura `<>` (linha 41), como primeiros filhos:

```tsx
    <>
      {(resumoStatus !== 'ok' || agingStatus !== 'ok') && (
        <div
          role="alert"
          className={`rounded-lg border p-3 text-xs ${
            resumoIndisponivel || agingStatus === 'unavailable'
              ? 'border-status-error/30 bg-status-error/5 text-status-error'
              : 'border-status-warning/30 bg-status-warning/5 text-status-warning'
          }`}
        >
          {resumoIndisponivel || agingStatus === 'unavailable'
            ? 'Alguns indicadores estão indisponíveis — não foi possível ler os dados. Exibimos "—" no lugar; nenhum número foi estimado.'
            : 'Mostrando o último dado carregado — a atualização falhou.'}
        </div>
      )}
```

Os 4 KPIs (linhas 74, 85, 96, 103) — adicionar `unavailable={resumoIndisponivel}` a cada `<KpiCard>`. Exemplo no primeiro:

```tsx
        <KpiCard
          title="A Receber"
          value={activeResumo?.total_a_receber || 0}
          icon={ArrowDownCircle}
          color="text-status-success"
          bgColor="bg-status-success-bg"
          subtitle={activeResumo?.total_vencido_receber
            ? `${fmt(activeResumo.total_vencido_receber)} vencido`
            : undefined}
          subtitleColor="text-status-error"
          unavailable={resumoIndisponivel}
        />
```

Os dois `<AgingCard>` (linhas 152-153) — passar `status={agingStatus}`:

```tsx
        <AgingCard title="Aging Recebíveis" data={agingReceber} type="receber" status={agingStatus} />
        <AgingCard title="Aging Pagáveis" data={agingPagar} type="pagar" status={agingStatus} />
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `heavy bun run test -- src/components/financeiro/dashboard/__tests__/KpiCard.test.tsx src/components/financeiro/dashboard/__tests__/VisaoGeralTab.test.tsx`
Expected: PASS — casos antigos + novos verdes.

- [ ] **Step 5: Falsificar**

1. Em `KpiCard`, trocar `{unavailable ? '—' : fmtCompact(value)}` por `{fmtCompact(value)}`. Rodar → vermelho em `unavailable → "—"`. Reverter.
2. Em `AgingCard`, trocar a condicional do `if (!data)` de volta para só `<Skeleton className="h-40" />`. Rodar → vermelho em `agingStatus=unavailable → ... skeleton eterno`. Reverter.
3. Em `VisaoGeralTab`, remover o bloco de banners. Rodar → vermelho em `resumoStatus=unavailable → banner`. Reverter.

Confirmar o denominador de cada arquivo a cada rodada; reconfirmar tudo verde ao fim.

- [ ] **Step 6: Commit**

```bash
git add src/components/financeiro/dashboard/KpiCard.tsx src/components/financeiro/dashboard/AgingCard.tsx src/components/financeiro/dashboard/VisaoGeralTab.tsx src/components/financeiro/dashboard/__tests__/KpiCard.test.tsx src/components/financeiro/dashboard/__tests__/VisaoGeralTab.test.tsx
git commit -m "fix(financeiro): VisaoGeral e Aging dizem 'indisponivel' em vez de R\$0/skeleton [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `FinanceiroDashboard` — fiação (deriva status, passa aos filhos)

**Files:**
- Modify: `src/pages/FinanceiroDashboard.tsx` (desestruturação `:32-42`; JSX das tabs `:181`, `:228`)

**Interfaces:**
- Consumes: `errors` do `useFinanceiro` (Task 4); `statusFrom` (Task 1); props de status de `VisaoGeralTab`/`FluxoCaixaTab` (Tasks 5-6).
- Produces: nada (página terminal).

Esta task é fiação; a lógica está nos helpers/hooks já testados. Validação = typecheck + suíte do módulo (não há teste unitário da página).

- [ ] **Step 1: Implementar a fiação**

Em `src/pages/FinanceiroDashboard.tsx`:

**(a)** Import (após a linha 23, `import { useAuth } ...`):

```ts
import { statusFrom } from '@/components/financeiro/dashboard/dataStatus';
```

**(b)** Desestruturação do hook (linha 32-42) — adicionar `errors`:

```ts
  const {
    view, setView, loading, syncing, error, errors, lastSync,
    activeResumo, resumo,
    contasPagar, contasReceber,
    agingReceber, agingPagar,
    dreConsolidado, drePorEmpresa,
    fluxoCaixa, inadimplentes,
    loadResumo, loadContasPagar, loadContasReceber,
    loadAging, loadDRE, loadFluxoCaixa, loadInadimplentes,
    syncAll, calcularDRE, calcularDREAnual,
  } = useFinanceiro('all');
```

**(c)** Derivar os status — logo após `const lockHandler = usePeriodLockHandler();` (linha 46):

```ts
  const resumoStatus = statusFrom(!!errors.resumo, !!activeResumo);
  const agingStatus = statusFrom(!!errors.aging, !!agingReceber);
  const fluxoStatus = statusFrom(!!errors.fluxoCaixa, fluxoCaixa.length > 0);
```

**(d)** Passar aos filhos. `VisaoGeralTab` (linha 181):

```tsx
          <VisaoGeralTab
            alerts={alerts}
            activeResumo={activeResumo}
            resumo={resumo}
            view={view}
            agingReceber={agingReceber}
            agingPagar={agingPagar}
            inadimplentes={inadimplentes}
            resumoStatus={resumoStatus}
            agingStatus={agingStatus}
          />
```

`FluxoCaixaTab` (linha 228):

```tsx
          <FluxoCaixaTab data={fluxoCaixa} loading={loading} saldoCC={activeResumo?.saldo_total_cc} status={fluxoStatus} />
```

(O banner global `{error && (...)}` na linha 160 **não muda** — `error` agora é só de sync, que é o que ele deve mostrar.)

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS (exit 0). Se falhar por `errors` inexistente no tipo do hook, revisar a Task 4 Step 3(f).

- [ ] **Step 3: Rodar a suíte inteira do módulo**

Run: `heavy bun run test -- src/components/financeiro src/services/__tests__ src/hooks/__tests__ > /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-serene-boyd-432fe7/9506d1de-7918-43af-991d-00a0d6f07722/scratchpad/gate-final.log 2>&1; echo "exit=$?"`
Expected: exit 0; denominador ≥ baseline (80) + os testes novos. Conferir `Tests  N passed (N)` no log — nenhum `failed`.

- [ ] **Step 4: Lint**

Run: `bun lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/FinanceiroDashboard.tsx
git commit -m "fix(financeiro): dashboard deriva status por dataset e propaga aos filhos [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verificação final (antes do PR)

- [ ] Reconferir coordenação multi-sessão: `git fetch origin main`; `gh pr list` — nenhum PR novo tocando `useFinanceiro.ts`/`financeiroService.ts`/`VisaoGeralTab.tsx`. Re-checar imediatamente antes do `gh pr create` (o auto-merge fecha PR em minutos).
- [ ] `heavy bun run typecheck` · `heavy bun run test` · `bun lint` — todos verdes, com denominador conferido (não prever verde de gate na fila).
- [ ] Abrir PR-A não-draft (auto-merge no CI verde). Armar `scripts/pr-watch.sh <nº>` em background; avisar o desfecho por PushNotification.
- [ ] Após merge: **Publish do frontend** no Lovable (mudança só-`src/`, sem migration/edge). Anunciar no chat a pendência de Publish e o comando `cd <worktree>` se houver algo pro terminal do founder.
- [ ] Abrir o **chip do PR-B** (`spawn_task`) para Cockpit/Zone/PosicaoAgora; anunciar o título exato no chat (quem clica é o founder).

## Self-Review (feito)

**Spec coverage:** D1 (Task 4 preserva dado + errors por dataset) · D2 (Task 4 `clearDatasetError` + `error` só sync; Task 7 banner de sync) · D3 (Task 2 aging lança; Task 3 anti-regressão cockpit) · D4 (Task 5 acumulado honesto). Padrão 3-estados (Task 1) usado por Tasks 5-7. Empty-state de sync vs falha (Task 5). PR-B fora de escopo (chip na verificação final). ✅ sem lacuna.

**Placeholder scan:** nenhum TBD/TODO; todo step de código tem o código real. ✅

**Type consistency:** `DataStatus` (`'ok'|'stale'|'unavailable'`) e `statusFrom(hasError, hasData)` idênticos em Tasks 1/5/6/7. `DatasetKey` idêntico em Task 4 e nas derivações da Task 7 (`errors.resumo`/`errors.aging`/`errors.fluxoCaixa`). `EMPTY_AGING` exportado na Task 2, consumido na Task 3. Props `unavailable`/`status`/`resumoStatus`/`agingStatus` casam entre componente e chamador. ✅
