# Orçamento Rolling — Plano sub-PR B: Seed de Baixa Fricção

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development. **Codex em todas as etapas** (regra da fronteira #3): metodologia ✓ (na spec) · plano ← Codex antes de executar · código ← Codex adversarial (Task 3).

**Goal:** Botão "Sugerir orçamento {ano}" que pré-preenche o orçamento de cada (linha, mês) a partir do realizado do ano anterior × (1+crescimento%), **winsorizando outliers** e **não sugerindo** quando a amostra é curta/esparsa. O founder revisa e salva (mata as ~120 células digitadas). Client-side, sem migration.

**Architecture:** Helper puro `seedOrcamento` (append em `src/lib/financeiro/orcamento-forecast-helpers.ts`, TDD) + botão na `FinanceiroOrcamento.tsx` que chama o seed sobre `dreAnoAnterior` (já carregado no sub-PR A) e popula o `draft` do modo de edição. **Sem migration, sem edge function.** Spec: `docs/superpowers/specs/2026-05-27-orcamento-rolling-design.md` (seção Seed). Drill de variância = passo focado SEPARADO (decisão do founder: precisa de atribuição por código, não por descrição).

---

### Task 1: Helper `seedOrcamento` (TDD)

**Files:** Modify `src/lib/financeiro/orcamento-forecast-helpers.ts` + `__tests__/orcamento-forecast-helpers.test.ts`

Contrato:
```ts
export type SeedFlag = 'winsorizado' | 'amostra_curta_sem_sugestao' | 'mes_ausente_media';
export type SeedLinha = { dre_linha: string; mes: number; valor_sugerido: number | null; flag?: SeedFlag };
export function seedOrcamento(input: {
  dreBase: MesDRE[];        // realizado do ano-base (ano anterior)
  crescimentoPerc: number;  // ex. 10 = +10% (aceita negativo/decimal)
  fatorOutlier?: number;    // default 3 — cap por múltiplo da MEDIANA (robusto a outlier)
}): SeedLinha[];
```

`round2(n) = Math.round((n + Number.EPSILON) * 100) / 100`.

**Lógica por LINHA_INPUT (emite 12 SeedLinha, mes 1..12). Linhas são MAGNITUDES POSITIVAS; crescimento multiplica todas por `(1+g/100)`, inclusive despesas/deduções/impostos — sem inverter sinal.**
1. Pra cada mês 1..12: `presente[mes] = dreBase tem aquele mes` e `v[mes] = mesDRE?.[linha] ?? 0`.
2. **`mesesComValor` = meses com `v != 0`** (⚠️ **zero = sem-movimento → NÃO entra nas estatísticas nem conta como amostra**; tratado como ausente no passo 5). Se `mesesComValor.length < 3` → **amostra curta/esparsa**: emite os 12 meses com `valor_sugerido: null, flag: 'amostra_curta_sem_sugestao'` (NÃO fabrica — Codex). Cobre também: `dreBase` vazio, 1 valor, todos zero.
3. **Winsorize por múltiplo da mediana** (robusto — std com o próprio outlier infla o limite): `mediana` dos valores de `mesesComValor` (todos > 0 → mediana > 0). `capSup = mediana × fatorOutlier`, `capInf = mediana / fatorOutlier`. Pra cada mês em `mesesComValor`: `vCap = clamp(v, capInf, capSup)`; se `vCap !== v` → marca esse mês como winsorizado.
4. `mediaCap` = média dos `vCap` dos `mesesComValor`.
5. Por mês 1..12:
   - se o mês está em `mesesComValor` → `valor_sugerido = round2(vCap[mes] × (1+g/100))`; `flag = 'winsorizado'` se capou, senão sem flag.
   - senão (zero ou ausente) → `valor_sugerido = round2(mediaCap × (1+g/100))`, `flag = 'mes_ausente_media'` (honesto: mês fabricado pela média; founder revê — importante p/ sazonalidade).

- [ ] **Step 1: testes que falham** (APPEND ao fim do test file; adicione `seedOrcamento` ao import):

```ts
import { seedOrcamento, type MesDRE } from '../orcamento-forecast-helpers';

describe('seedOrcamento', () => {
  const base = (linha: string, vals: number[]): MesDRE[] => vals.map((v, i) => ({ mes: i + 1, [linha]: v }));
  const linhaSeed = (seed: ReturnType<typeof seedOrcamento>, l: string) => seed.filter(s => s.dre_linha === l);

  it('amostra curta (<3 meses com valor; zero NÃO conta) → null + flag', () => {
    const seed = seedOrcamento({ dreBase: base('receita_bruta', [100, 100, 0,0,0,0,0,0,0,0,0,0]), crescimentoPerc: 10 });
    const rb = linhaSeed(seed, 'receita_bruta');
    expect(rb).toHaveLength(12);
    expect(rb.every(s => s.valor_sugerido === null && s.flag === 'amostra_curta_sem_sugestao')).toBe(true);
  });

  it('bordas sem NaN: vazio / 1 valor / todos zero → null; 12 iguais → finito sem winsorizado', () => {
    expect(linhaSeed(seedOrcamento({ dreBase: [], crescimentoPerc: 10 }), 'cmv').every(s => s.valor_sugerido === null)).toBe(true);
    expect(linhaSeed(seedOrcamento({ dreBase: base('cmv', [500,0,0,0,0,0,0,0,0,0,0,0]), crescimentoPerc: 10 }), 'cmv').every(s => s.valor_sugerido === null)).toBe(true);
    expect(linhaSeed(seedOrcamento({ dreBase: base('cmv', Array(12).fill(0)), crescimentoPerc: 10 }), 'cmv').every(s => s.valor_sugerido === null)).toBe(true);
    const iguais = linhaSeed(seedOrcamento({ dreBase: base('cmv', Array(12).fill(100)), crescimentoPerc: 0 }), 'cmv');
    expect(iguais.every(s => Number.isFinite(s.valor_sugerido!) && s.flag === undefined)).toBe(true);
  });

  it('crescimento mês a mês (12 iguais)', () => {
    const da = linhaSeed(seedOrcamento({ dreBase: base('despesas_administrativas', Array(12).fill(100)), crescimentoPerc: 10 }), 'despesas_administrativas');
    expect(da.every(s => s.valor_sugerido === 110)).toBe(true);
  });

  it('winsorize por múltiplo da mediana: cap EXATO = mediana×fator (g=0)', () => {
    // 11×100 + 1×10000. mediana=100, fator=3 → capSup=300. outlier (mês 6) → 300.
    const vals = Array(12).fill(100); vals[5] = 10000;
    const dc = linhaSeed(seedOrcamento({ dreBase: base('despesas_comerciais', vals), crescimentoPerc: 0, fatorOutlier: 3 }), 'despesas_comerciais');
    const mesOutlier = dc.find(s => s.mes === 6)!;
    expect(mesOutlier.flag).toBe('winsorizado');
    expect(mesOutlier.valor_sugerido).toBe(300); // EXATO: mediana(100)×3
    expect(dc.find(s => s.mes === 1)!.valor_sugerido).toBe(100); // não-outlier intacto
  });

  it('mês ausente → mediaCap (com winsorize) + flag mes_ausente_media', () => {
    // presentes jan-jun: [100,100,100,100,100,10000]; jul-dez ausentes. g=0, fator=3.
    // mediana=100, capSup=300, outlier→300. mediaCap=(100*5+300)/6=133.333.
    const dreBase = [100,100,100,100,100,10000].map((v,i)=>({ mes:i+1, cmv:v }));
    const cmv = linhaSeed(seedOrcamento({ dreBase, crescimentoPerc: 0, fatorOutlier: 3 }), 'cmv');
    expect(cmv).toHaveLength(12);
    const ausente = cmv.find(s => s.mes === 11)!;
    expect(ausente.flag).toBe('mes_ausente_media');
    expect(ausente.valor_sugerido!).toBeCloseTo(133.33, 2); // mediaCap (capado), NÃO média crua (1750)
  });

  it('round2 + crescimento negativo (magnitude positiva, sem inverter sinal)', () => {
    const dc = linhaSeed(seedOrcamento({ dreBase: base('despesas_operacionais', Array(12).fill(1000)), crescimentoPerc: -10 }), 'despesas_operacionais');
    expect(dc.every(s => s.valor_sugerido === 900)).toBe(true);
  });
});
```

- [ ] **Step 2-4: TDD** (ver falhar → implementar `seedOrcamento` + `round2` interno → ver passar; suíte do arquivo inteira verde).
- [ ] **Step 5: commit** — `feat(orcamento): seedOrcamento (sugestão winsorizada + bloqueio de amostra curta) + testes`.

---

### Task 2: Página — botão "Sugerir orçamento"

**Files:** Modify `src/pages/FinanceiroOrcamento.tsx`

- [ ] **Step 1:** No modo de edição (`editMode`), adicionar um controle: input de **crescimento %** (default 10) + botão **"Sugerir a partir de {ano-1}"**. Ao clicar: `const seed = seedOrcamento({ dreBase: dreAnoAnteriorMesDRE, crescimentoPerc })` (reusa o `dreAnoAnterior`/`dreAnoAnteriorMesDRE` já carregado no sub-PR A). Para cada `SeedLinha` com `valor_sugerido != null`, escrever no `draft` (`draft[`${mes}_${dre_linha}`] = valor_sugerido`). Linhas com `null` (amostra curta) NÃO preenche (deixa em branco/0). Toast: "Orçamento sugerido a partir de {ano-1} (+{g}%). Revise e salve." + se houve linhas puladas (amostra curta) ou winsorizadas, mencionar ("X meses ajustados por outlier; Y linhas sem histórico suficiente").
- [ ] **Step 2:** Confirmar que o seed só popula o `draft` (NÃO salva automático) — o founder revisa e clica em "Salvar" (fluxo existente). Não toca em `upsertOrcamento` direto.
- [ ] **Step 3:** `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` limpos.
- [ ] **Step 4: commit** — `feat(orcamento): botão "Sugerir orçamento" (seed winsorizado) no modo de edição`.

---

### Task 3: Docs + validação + Codex adversarial + PR

- [ ] **Step 1:** atualizar a seção Orçamento no `docs/FINANCEIRO_CONFIABILIDADE.md` (seed entregue; drill segue como passo focado).
- [ ] **Step 2: validação** — `heavy bun run test` + `heavy bun run typecheck:strict` + `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` + `heavy bun run build`.
- [ ] **Step 3: Codex ADVERSARIAL** no `seedOrcamento` + integração: winsorize correto (não capa demais/de menos)? amostra curta realmente bloqueia? mês ausente preenchido sem fabricar? crescimento aplicado certo? algum NaN (desvio 0, array vazio)? Incorporar P1/P2.
- [ ] **Step 4: PR** — push; `gh pr create` (sem migration/deploy — client-side); auto-merge `--squash --auto`.

---

## Notas
- **Sem migration, sem edge function, sem deploy** (client-side; só popula o draft existente).
- **`tsc --noEmit -p tsconfig.app.json`** é o typecheck que pega o `src` (CI `tsc --noEmit` puro é no-op).
- **Drill de variância por categoria** = passo focado SEPARADO (precisa de atribuição por CÓDIGO via `fin_categoria_dre_mapping`, não por descrição — risco de mis-atribuição senão). Não está neste sub-PR.
