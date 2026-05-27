# Orçamento Rolling — Plano sub-PR A: Forecast de Aterrissagem + Variância Projetada

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Passos com checkbox. **Regra desta fronteira: Codex em todas as etapas** (metodologia ✓, spec ✓ [2 passes], plano ✓ [1 passe — findings incorporados abaixo], código ← Codex adversarial na Task 4).

**Goal:** Projetar onde o ano FECHA (realizado dos meses fechados + forecast dos restantes, por método-por-linha) e a variância projetada vs orçado, sobre a página `/financeiro/orcamento` que já existe. Client-side, sem edge function, sem migration.

**Architecture:** Helper puro TDD `src/lib/financeiro/orcamento-forecast-helpers.ts` (orquestrador ordenado `projetarDRE`) + estende `src/pages/FinanceiroOrcamento.tsx` + item na sidebar. Reusa `getDRE(company, ano, undefined, regime)` (ano e ano-1) + `getOrcamento`.

**Tech Stack:** TypeScript, vitest, React + shadcn/ui. **Spec:** `docs/superpowers/specs/2026-05-27-orcamento-rolling-design.md`.

**⚠️ Decisões travadas pelo Codex (plano):**
- **Nomes das derivadas = FinDRE** (não inventar): `receita_liquida, lucro_bruto, resultado_operacional, resultado_antes_impostos, resultado_liquido`.
- **Regime explícito**: o helper é regime-AGNÓSTICO (recebe os arrays de DRE). A página passa **um** regime consistente pros dois (ano + ano-1). ⚠️ A página atual chama `getDRE` no default (`competencia`) mas exibe badge "Regime de Caixa" — **inconsistência pré-existente**; a Task 3 deixa o regime explícito e há um item de follow-up pra confirmar com o founder qual é o correto. v1: usar o MESMO que a comparação orçado×realizado existente já usa (consistência) = `competencia` (default atual), explícito.
- **`orcado` distingue AUSENTE de ZERO**: `Partial<Record<LinhaInput, (number|null)[]>>` — chave ausente OU todos null → `orcado_ano=null` (variância não computável). Senão soma `(x ?? 0)`.

---

### Task 0: Branch + spec (FEITO)
- [x] Branch `feat/orcamento-rolling` de `origin/main`. Spec commitada (2 passes Codex).

---

### Task 1: Helper — primitivas (TDD)

**Files:** Create `src/lib/financeiro/orcamento-forecast-helpers.ts` + `__tests__/orcamento-forecast-helpers.test.ts`

```ts
export const LINHAS_INPUT = ['receita_bruta','deducoes','cmv','despesas_operacionais','despesas_administrativas','despesas_comerciais','despesas_financeiras','receitas_financeiras','outras_receitas','outras_despesas','impostos'] as const;
export type LinhaInput = typeof LINHAS_INPUT[number];
export const LINHAS_RECEITA = new Set<string>(['receita_bruta','receitas_financeiras','outras_receitas']);
export const LINHAS_DESPESA_FIXA = new Set<string>(['despesas_operacionais','despesas_administrativas','despesas_comerciais']); // run-rate
export const LINHAS_FINANCEIRA = new Set<string>(['receitas_financeiras','despesas_financeiras']); // média móvel 3m
export const LINHAS_DERIV_FAVORAVEL_CIMA = new Set<string>(['receita_liquida','lucro_bruto','resultado_operacional','resultado_antes_impostos','resultado_liquido']);
export type MesDRE = { mes: number } & Partial<Record<LinhaInput, number>>;
export type DerivadasResult = { receita_liquida: number; lucro_bruto: number; resultado_operacional: number; resultado_antes_impostos: number; resultado_liquido: number };
```

- [ ] **Step 1: testes que falham** — `mesesFechados`, `razaoYTD`, `fatorTendenciaYTD`, `derivarLinhas`:

```ts
import { describe, it, expect } from 'vitest';
import { mesesFechados, razaoYTD, fatorTendenciaYTD, derivarLinhas } from '../orcamento-forecast-helpers';

describe('mesesFechados', () => {
  it('ano corrente exclui o mês corrente e futuros', () => { expect(mesesFechados(2026, new Date('2026-05-15'))).toEqual([1,2,3,4]); });
  it('ano passado = 12', () => { expect(mesesFechados(2025, new Date('2026-05-15'))).toHaveLength(12); });
  it('ano futuro = []', () => { expect(mesesFechados(2027, new Date('2026-05-15'))).toEqual([]); });
});
describe('razaoYTD', () => {
  it('Σnum/Σden', () => { expect(razaoYTD([10,20],[100,100])).toBeCloseTo(0.15,6); });
  it('denominador <=0 → null', () => { expect(razaoYTD([10],[0])).toBeNull(); expect(razaoYTD([10],[-5])).toBeNull(); });
  it('vazio → null', () => { expect(razaoYTD([],[])).toBeNull(); });
});
describe('fatorTendenciaYTD', () => {
  it('Σreceita atual / ano-1 (mesmos meses), cap [0.5,2.0]', () => {
    expect(fatorTendenciaYTD([{mes:1,receita_bruta:110},{mes:2,receita_bruta:130}],[{mes:1,receita_bruta:100},{mes:2,receita_bruta:100}],[1,2])).toBeCloseTo(1.2,6);
  });
  it('cap superior 2.0', () => { expect(fatorTendenciaYTD([{mes:1,receita_bruta:500}],[{mes:1,receita_bruta:100}],[1])).toBe(2.0); });
  it('base ano-1 <=0 → null', () => { expect(fatorTendenciaYTD([{mes:1,receita_bruta:100}],[],[1])).toBeNull(); });
});
describe('derivarLinhas', () => {
  it('fórmulas e sinais (FinDRE)', () => {
    const d = derivarLinhas({ receita_bruta:1000, deducoes:100, cmv:400, despesas_operacionais:50, despesas_administrativas:30, despesas_comerciais:20, receitas_financeiras:10, despesas_financeiras:5, outras_receitas:0, outras_despesas:0, impostos:40 });
    expect(d.receita_liquida).toBe(900);
    expect(d.lucro_bruto).toBe(500);
    expect(d.resultado_operacional).toBe(400);
    expect(d.resultado_antes_impostos).toBe(405); // 400 +10 -5 +0 -0
    expect(d.resultado_liquido).toBe(365); // 405 - 40
  });
  it('campos omitidos = 0, sem NaN (Codex P3)', () => {
    const d = derivarLinhas({ receita_bruta:500 });
    expect(d.receita_liquida).toBe(500); expect(Number.isNaN(d.resultado_liquido)).toBe(false); expect(d.resultado_liquido).toBe(500);
  });
});
```

- [ ] **Step 2-4: TDD.** Impl:
  - `mesesFechados(ano, hoje=new Date())`: `ano<hoje.getFullYear()`→1..12; `>`→[]; `=`→`1..(hoje.getMonth())` (getMonth 0-based → mês corrente em curso excluído).
  - `razaoYTD(num[],den[])`: `s=Σden`; `s<=0`→null; senão `Σnum/s`.
  - `fatorTendenciaYTD(atual,anoAnt,fechados)`: soma `receita_bruta` nos `fechados` de cada; base anoAnt `<=0`→null; senão `clamp(somaAtual/somaAnt,0.5,2.0)`.
  - `derivarLinhas(i)`: usa `(i.x ?? 0)`; aplica as 5 fórmulas FinDRE.
- [ ] **Step 5: commit** — `feat(orcamento): primitivas de forecast + testes`.

---

### Task 2: Helper — `projetarDRE` (pipeline ordenado) + variância (TDD)

**Contrato:**
```ts
export type MetodoForecast = 'sazonal_ajustado'|'run_rate'|'driver_receita'|'media_movel'|'razao_ytd_imposto'|'orcado_remanescente'|'sem_forecast';
export type ForecastLinha = { dre_linha: string; realizado_fechado: number; forecast_restante: number; landing: number; orcado_ano: number|null; variancia: number|null; favoravel: boolean|null; fura_meta: boolean; metodo: MetodoForecast; confianca: 'alta'|'media'|'baixa'; flags: string[] };
export type ForecastResult = { company: string; ano: number; meses_fechados: number; linhas: ForecastLinha[]; confianca_geral: 'alta'|'media'|'baixa'; motivos: string[] };
export function projetarDRE(input: {
  company: string; ano: number; hoje?: Date;
  dreAtual: MesDRE[]; dreAnoAnterior: MesDRE[];
  orcado: Partial<Record<LinhaInput, (number|null)[]>>; // [mes-1]; chave ausente/all-null → orcado_ano=null
  pisoFuraMeta?: number; // default 5000
}): ForecastResult;
```

**Ordem topológica (por mês restante), depois agrega:**
`receita_bruta` → `deducoes (driver razaoYTD ded/receita × receita_bruta_FC)` → `receita_liquida (calc)` → `cmv (driver razaoYTD cmv/recliq × receita_liquida_FC)` → despesas fixas (run-rate) / financeiras (média 3m) / outras (run-rate) → `impostos (razaoYTD imp/receita × receita_bruta_FC)` → derivadas (calc).
**Métodos por linha:** `receita_bruta`: sazonal_ajustado se `fator!=null` E há `ano-1[mes]`; senão run-rate (média fechados); senão orcado_remanescente. **Despesas: lista LITERAL** (`LINHAS_DESPESA_FIXA`=run-rate; `LINHAS_FINANCEIRA`=média últimos 3 fechados; `outras_*`=run-rate). **Guard:** driver com `razaoYTD==null` (denominador≤0) → degrada p/ run-rate da própria linha + flag `denominador_zero`.
**orcado_ano:** input = `null` se chave ausente/all-null, senão `Σ(x??0)`. **Derivadas (landing E orcado_ano): `derivarLinhas`** (orcado: inputs null→0, flag `orcado_incompleto` se algum input null).
**Variância:** `variancia=landing−orcado_ano` (null se orcado_ano null). `favoravel = (LINHAS_RECEITA.has(l)||LINHAS_DERIV_FAVORAVEL_CIMA.has(l)) ? variancia>=0 : variancia<=0`. `fura_meta = variancia!=null && |variancia| > (orcado_ano>0 ? max(0.10*orcado_ano, piso) : piso)`.
**Confiança (precedência):** `meses_fechados===0` → todas `sem_forecast`/forecast_restante=0/confianca baixa + motivo "aguardando 1º mês fechado". Senão por linha: guard-degradado (denominador_zero) OU `<3` fechados em linha variável (receita/cmv/comerciais) OU imposto `<3` fechados → **baixa**; sazonal indisponível→run-rate (sem ano-1) → **media**; senão **alta**. `confianca_geral` = pior das linhas com orçado.

- [ ] **Step 1: testes que falham — ASSERTIVOS (forecasted DIVERGE do histórico; Codex P1):**

```ts
import { projetarDRE, LINHAS_INPUT } from '../orcamento-forecast-helpers';
// orçado: por padrão AUSENTE (não zero). orcUniforme preenche só as linhas passadas.
const orcUniforme = (vals: Partial<Record<string,number>>) => { const o: Partial<Record<string, (number|null)[]>> = {}; for (const k of Object.keys(vals)) o[k as never] = Array(12).fill(vals[k]); return o; };

it('0 meses fechados → sem forecast, forecast_restante=0, sem NaN', () => {
  const r = projetarDRE({ company:'oben', ano:2026, hoje:new Date('2026-01-10'), dreAtual:[], dreAnoAnterior:[], orcado:orcUniforme({receita_bruta:100}) });
  expect(r.meses_fechados).toBe(0);
  const rb = r.linhas.find(l=>l.dre_linha==='receita_bruta')!;
  expect(rb.metodo).toBe('sem_forecast'); expect(rb.forecast_restante).toBe(0); expect(Number.isFinite(rb.landing)).toBe(true);
});

it('sazonal ajustado É USADO e deduções/cmv usam a base FORECASTED (não histórica)', () => {
  // hoje fev → fechado jan. atual jan receita 120; ano-1 jan-dez receita 100/mês.
  // fator = 120/100 = 1.2 → forecast receita de cada mês restante = 100(ano-1) × 1.2 = 120.
  // deducoes jan=12 → razão 12/120=0.10 → forecast deducoes mês = 0.10×120=12.
  // cmv jan=48 → receita_liquida jan=108 → razão 48/108=0.4444 → forecast cmv mês=0.4444×(120-12)=48.
  const anoAnt = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:100, deducoes:10, cmv:40}));
  const r = projetarDRE({ company:'oben', ano:2026, hoje:new Date('2026-02-10'), dreAtual:[{mes:1,receita_bruta:120,deducoes:12,cmv:48}], dreAnoAnterior:anoAnt, orcado:{} });
  const rb = r.linhas.find(l=>l.dre_linha==='receita_bruta')!;
  expect(rb.metodo).toBe('sazonal_ajustado');
  expect(rb.forecast_restante).toBeCloseTo(120*11, 0); // 11 meses restantes (fev-dez) × 120
  const ded = r.linhas.find(l=>l.dre_linha==='deducoes')!;
  expect(ded.forecast_restante).toBeCloseTo(12*11, 0); // prova driver sobre receita FORECASTED (120), não histórica
  const cmv = r.linhas.find(l=>l.dre_linha==='cmv')!;
  expect(cmv.forecast_restante).toBeCloseTo(48*11, 0); // prova cmv sobre receita_liquida FORECASTED
});

it('imposto razão-YTD ≠ média mensal (números divergentes)', () => {
  // fechados jan(imp 0, rec 100), fev(imp 60, rec 200), mar(imp 0, rec 100). hoje abr.
  // média mensal imposto = 20/mês × 9 = 180. razão YTD = 60/400=0.15; receita run-rate=400/3≈133.3/mês ×9=1200; imposto=0.15×1200=180? 
  // → escolher números que divirjam: rec jan100/fev100/mar100 (run-rate=100), imp 0/0/45 → razão=45/300=0.15 → forecast=0.15×100×9=135; média mensal=15×9=135 (igual). 
  // Pra divergir: rec 100/100/400 (run-rate=200/mês), imp 0/0/60 → razão=60/600=0.10 → 0.10×200×9=180; média mensal imposto=20×9=180 (ainda igual pois receita média ∝). 
  // Divergência real: receita NÃO constante no forecast. Use sazonal: ano-1 dá receita restante alta enquanto imposto YTD baixo.
  const anoAnt = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:300}));
  const dre = [{mes:1,receita_bruta:100,impostos:5},{mes:2,receita_bruta:100,impostos:5},{mes:3,receita_bruta:100,impostos:5}]; // razão=15/300=0.05
  const r = projetarDRE({ company:'colacor', ano:2026, hoje:new Date('2026-04-10'), dreAtual:dre, dreAnoAnterior:anoAnt, orcado:{} });
  const imp = r.linhas.find(l=>l.dre_linha==='impostos')!;
  expect(imp.metodo).toBe('razao_ytd_imposto');
  // fator tendência=300/(3×300? não, mesmos meses fechados jan-mar ano-1=900) → 300/900=0.333 → cap 0.5 → receita FC mês=300×0.5=150
  // imposto FC = 0.05 × 150 × 9 = 67.5  (média mensal seria 5×9=45 → DIVERGE)
  expect(imp.forecast_restante).toBeCloseTo(0.05*150*9, 0);
  expect(imp.forecast_restante).not.toBeCloseTo(5*9, 0);
});

it('mês corrente PARCIAL não entra na base nem no landing por realizado', () => {
  // hoje maio. fechados jan-abr receita 100/mês. maio parcial ENORME (9999) presente em dreAtual.
  const dre = [1,2,3,4].map(m=>({mes:m, receita_bruta:100})).concat([{mes:5, receita_bruta:9999}]);
  const r = projetarDRE({ company:'oben', ano:2026, hoje:new Date('2026-05-20'), dreAtual:dre, dreAnoAnterior:[], orcado:{} });
  const rb = r.linhas.find(l=>l.dre_linha==='receita_bruta')!;
  expect(rb.realizado_fechado).toBe(400); // só jan-abr; maio parcial NÃO entra
  expect(rb.forecast_restante).toBeCloseTo(100*8,0); // run-rate 100 × 8 (mai-dez)
});

it('variância sign-aware — parametrizado, nenhuma invertida', () => {
  // landing > orcado em TODAS. receita acima=favorável; custo/dedução/imposto acima=desfavorável.
  // monta dreAtual com 12 meses fechados (ano passado) p/ landing=realizado; orçado menor.
  const dre = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:100, deducoes:10, cmv:40, despesas_operacionais:5, despesas_administrativas:5, despesas_comerciais:5, despesas_financeiras:2, receitas_financeiras:3, outras_receitas:1, outras_despesas:1, impostos:8 }));
  const orc: Partial<Record<string,(number|null)[]>> = {}; for (const k of LINHAS_INPUT) orc[k] = Array(12).fill(1); // orçado baixo → landing>orçado
  const r = projetarDRE({ company:'oben', ano:2025, hoje:new Date('2026-05-10'), dreAtual:dre, dreAnoAnterior:[], orcado:orc });
  const fav = (l:string)=> r.linhas.find(x=>x.dre_linha===l)!.favoravel;
  expect(fav('receita_bruta')).toBe(true); expect(fav('receitas_financeiras')).toBe(true); expect(fav('outras_receitas')).toBe(true);
  expect(fav('deducoes')).toBe(false); expect(fav('cmv')).toBe(false); expect(fav('despesas_financeiras')).toBe(false); expect(fav('impostos')).toBe(false);
  expect(fav('resultado_liquido')).toBe(true); // derivada de resultado acima → favorável
});

it('orçado AUSENTE → variancia null (não 0)', () => {
  const dre = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:100}));
  const r = projetarDRE({ company:'oben', ano:2025, hoje:new Date('2026-05-10'), dreAtual:dre, dreAnoAnterior:[], orcado:{} }); // nada orçado
  const rb = r.linhas.find(l=>l.dre_linha==='receita_bruta')!;
  expect(rb.orcado_ano).toBeNull(); expect(rb.variancia).toBeNull(); expect(rb.fura_meta).toBe(false);
});

it('fura_meta com orcado<=0 usa só piso', () => {
  const dre = Array.from({length:12},(_,i)=>({mes:i+1, outras_despesas:500})); // landing=6000
  const orc = { outras_despesas: Array(12).fill(0) }; // orçado 0
  const r = projetarDRE({ company:'oben', ano:2025, hoje:new Date('2026-05-10'), dreAtual:dre, dreAnoAnterior:[], orcado:orc, pisoFuraMeta:5000 });
  const od = r.linhas.find(l=>l.dre_linha==='outras_despesas')!;
  expect(od.orcado_ano).toBe(0); expect(od.fura_meta).toBe(true); // |6000|>5000 piso; sem divisão por 0
});

it('denominador de driver <=0 → run-rate + flag, sem NaN/Infinity', () => {
  // receita_bruta fechada = 0 (mas há deducoes) → razão deducoes/receita = null → run-rate
  const dre = [{mes:1,receita_bruta:0,deducoes:10},{mes:2,receita_bruta:0,deducoes:10},{mes:3,receita_bruta:0,deducoes:10}];
  const r = projetarDRE({ company:'oben', ano:2026, hoje:new Date('2026-04-10'), dreAtual:dre, dreAnoAnterior:[], orcado:{} });
  const ded = r.linhas.find(l=>l.dre_linha==='deducoes')!;
  expect(ded.flags).toContain('denominador_zero');
  expect(Number.isFinite(ded.forecast_restante)).toBe(true);
  expect(ded.forecast_restante).toBeCloseTo(10*9,0); // run-rate 10/mês × 9
});

it('derivadas: landing E orcado_ano calculados das 11 linhas (não null)', () => {
  const dre = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:100, deducoes:10, cmv:40, impostos:8 }));
  const orc: Partial<Record<string,(number|null)[]>> = {}; for (const k of LINHAS_INPUT) orc[k]=Array(12).fill(k==='receita_bruta'?90: k==='deducoes'?9: k==='cmv'?36: k==='impostos'?7:0);
  const r = projetarDRE({ company:'oben', ano:2025, hoje:new Date('2026-05-10'), dreAtual:dre, dreAnoAnterior:[], orcado:orc });
  const rl = r.linhas.find(l=>l.dre_linha==='resultado_liquido')!;
  expect(rl.landing).toBeCloseTo(12*(100-10-40-8),0); // 42×12=504
  expect(rl.orcado_ano).toBeCloseTo(12*(90-9-36-7),0); // 38×12=456 (NÃO null)
  expect(rl.variancia).toBeCloseTo(504-456,0);
});
```

- [ ] **Step 2-4: TDD** — ver falhar → implementar `projetarDRE` na ordem topológica → ver passar. **Nenhum `NaN`/`Infinity` em nenhum campo.**
- [ ] **Step 5: commit** — `feat(orcamento): projetarDRE (pipeline ordenado) + variância sign-aware + degradação`.

---

### Task 3: Página — seção "Forecast de aterrissagem" + sidebar

**Files:** Modify `src/pages/FinanceiroOrcamento.tsx`, `src/components/AppShell.tsx`.

- [ ] **Step 1 — adapter explícito (Codex P2):** na página, montar:
  - `dreAtual = await getDRE(company, ano, undefined, REGIME)` e `dreAnoAnterior = await getDRE(company, ano-1, undefined, REGIME)`, com **`REGIME` explícito** = o mesmo que a comparação existente usa (hoje default `'competencia'` — manter consistente; ⚠️ ver follow-up de regime).
  - `orcado: Partial<Record<LinhaInput,(number|null)[]>>` a partir de `orcamento`/`draft`: pra cada linha que tem AO MENOS uma entrada, array de 12 (`mes` sem valor → 0); linha sem NENHUMA entrada → **omitir a chave** (→ orcado_ano null). NÃO inicializar tudo com zero.
  - `const fc = projetarDRE({ company, ano, dreAtual, dreAnoAnterior, orcado })`.
- [ ] **Step 2 — render:** card "Forecast de aterrissagem {ano}" com tabela por linha (inputs + 5 derivadas, na ordem do DRE): **Landing** (`realizado_fechado`+`forecast_restante`), **Orçado ano** (`—` se null), **Variância** (`text-status-success` se favoravel, `text-status-error` senão; `—` se null), **% vs orçado**, badge **"vai furar a meta"** se `fura_meta`, chips **método** + **confiança**. Banner quando `meses_fechados===0`. Labels das derivadas: mapa próprio (FinDRE não está em `DRE_LINHAS`). NUNCA `text-emerald/red-600`.
- [ ] **Step 3 — sidebar:** `AppShell.tsx` item `{ icon: Target, label: 'Orçamento', path: '/financeiro/orcamento' }` na seção Financeiro (rota órfã hoje). Mesmo gate da seção.
- [ ] **Step 4:** `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` limpos.
- [ ] **Step 5: commit** — `feat(orcamento): seção Forecast de aterrissagem + sidebar`.

---

### Task 4: Docs + validação + Codex adversarial + PR

- [ ] **Step 1:** seção no `docs/FINANCEIRO_CONFIABILIDADE.md` (método-por-linha, pipeline ordenado, imposto razão-YTD, variância sign-aware, regime explícito + ⚠️ follow-up caixa×competência, degradação, limitações v1, sub-PR B pendente).
- [ ] **Step 2: validação** — `heavy bun run test` + `heavy bun run typecheck:strict` + `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` + `heavy bun run build`.
- [ ] **Step 3: Codex ADVERSARIAL no código** (`orcamento-forecast-helpers.ts` + integração): ordem do pipeline no código, sinais das derivadas, sign-aware nas 16 linhas, guards NaN, imposto razão-YTD, adapter orçado ausente×zero. Incorporar P1/P2.
- [ ] **Step 4: PR** — push; `gh pr create` (sem migration/deploy — client-side); auto-merge `--squash --auto`.

---

## Notas
- **Sem migration, sem edge function** — client-side sobre `fin_orcamento`/DRE.
- **`tsc --noEmit -p tsconfig.app.json`** é o typecheck que pega o `src`.
- **Codex em todas as etapas**: metodologia ✓, spec ✓, plano ✓, código (Task 4 adversarial).
- **Follow-up de regime** (não bloqueia v1): confirmar com o founder se o orçamento é caixa ou competência (a página exibe "Regime de Caixa" mas chama `getDRE` no default competência). v1 mantém consistência com a comparação existente; corrigir nas duas telas juntas se for bug.
- **sub-PR B (plano separado):** drill de variância por categoria (`getAnaliseDimensional`) + seed winsorizado (`seedOrcamento`).
