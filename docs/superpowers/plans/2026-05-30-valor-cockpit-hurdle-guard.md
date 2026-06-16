# A3 Cockpit — Guard de hurdle indisponível — Plano

> Sub-skill: execução inline com TDD. Steps em checkbox.

**Goal:** A3 (`/financeiro/valor-cockpit`) para de fabricar hurdle 20% quando o Ke está ausente → `k=null`, encargo/EVP null (não fabricados), confiança baixa, recomendações de valor gated, UI sem "@ 20.0%". Margem (cm) e "Subir preço" seguem.

**Escopo (Codex):** (i) manter Ke; WACC é follow-up. Sem migration. Deploy do `fin-valor-cockpit` via Lovable.

**Spec:** `docs/superpowers/specs/2026-05-30-valor-cockpit-hurdle-guard-design.md`

---

### Task 1: Helper `valor-cockpit-helpers.ts` — TDD

**Files:** Modify `src/lib/financeiro/valor-cockpit-helpers.ts`; Test `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`

- [ ] **Step 1 — Testes falhando** (adicionar):

```ts
import { resolverHurdleCockpit, montarCelulasComboEVP, recomendarAcaoComercial, scoreConfiancaCockpit } from '../valor-cockpit-helpers';

describe('resolverHurdleCockpit', () => {
  it('ke.base ausente → null (não fabrica 0.20)', () => {
    expect(resolverHurdleCockpit({})).toBeNull();
    expect(resolverHurdleCockpit({ ke: {} })).toBeNull();
    expect(resolverHurdleCockpit(null)).toBeNull();
  });
  it('ke.base vazio {} → null (não 0 — 0% seria capital grátis)', () => {
    expect(resolverHurdleCockpit({ ke: { base: {} } })).toBeNull();
  });
  it('âncora ausente → null mesmo com prêmios', () => {
    expect(resolverHurdleCockpit({ ke: { base: { premio_risco_equity: 0.05 } } })).toBeNull();
  });
  it('âncora + prêmios válidos → soma', () => {
    expect(resolverHurdleCockpit({ ke: { base: { ancora: 0.11, premio_risco_equity: 0.05, premio_tamanho_private: 0.03, premio_iliquidez_controle: 0.02 } } })).toBeCloseTo(0.21, 10);
  });
  it('âncora só → soma (prêmios ausentes = 0)', () => {
    expect(resolverHurdleCockpit({ ke: { base: { ancora: 0.12 } } })).toBeCloseTo(0.12, 10);
  });
  it('âncora string numérica (PostgREST) → número', () => {
    expect(resolverHurdleCockpit({ ke: { base: { ancora: '0.1' } } })).toBeCloseTo(0.1, 10);
  });
  it('soma ≤ 0 → null', () => {
    expect(resolverHurdleCockpit({ ke: { base: { ancora: 0 } } })).toBeNull();
  });
});

describe('montarCelulasComboEVP — k nullable', () => {
  const combos = [{ cliente: 'A', sku: '1', receita_liquida: 1000, quantidade: 10, custo_unitario: 50 }];
  const capCli = [{ cliente: 'A', ar_medio: 2000 }];
  const capSku = [{ sku: '1', estoque_valor: 500 }];
  it('k número → encargo/evp calculados (happy-path), asserts EXATOS em rollup/empresa (Codex P2.3)', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    expect(r.celulas[0].encargo).toBeCloseTo(0.2 * (2000 + 500), 6); // 500
    expect(r.celulas[0].evp).toBeCloseTo(500 - 0.2 * 2500, 6);       // 0
    expect(r.porCliente[0].encargo).toBeCloseTo(500, 6);
    expect(r.porCliente[0].encargo_total).toBeCloseTo(500, 6);
    expect(r.porCliente[0].evp).toBeCloseTo(0, 6);
    expect(r.porSKU[0].encargo).toBeCloseTo(500, 6);
    expect(r.empresa.encargo).toBeCloseTo(500, 6);
    expect(r.empresa.encargo_total).toBeCloseTo(500, 6);
    expect(r.empresa.evp).toBeCloseTo(0, 6);
  });
  it('k null → encargo/evp null em célula/rollup/empresa; cm segue; acumulador NÃO coage', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: null });
    expect(r.celulas[0].encargo).toBeNull();
    expect(r.celulas[0].evp).toBeNull();
    expect(r.celulas[0].cm).toBe(500); // 1000 − 50*10
    expect(r.porCliente[0].encargo).toBeNull();
    expect(r.porCliente[0].encargo_total).toBeNull(); // NÃO 0
    expect(r.porCliente[0].evp).toBeNull();
    expect(r.empresa.encargo).toBeNull();
    expect(r.empresa.encargo_total).toBeNull();
    expect(r.empresa.evp).toBeNull();
    expect(r.empresa.cm).toBe(500);
  });
  it('MISTO k=null + célula cm=null no mesmo cliente (Codex P1.2): custo-ausente ≠ hurdle-ausente', () => {
    const combos2 = [
      { cliente: 'A', sku: '1', receita_liquida: 1000, quantidade: 10, custo_unitario: 50 }, // cm=500
      { cliente: 'A', sku: '2', receita_liquida: 800, quantidade: 5, custo_unitario: null },  // cm=null
    ];
    const r = montarCelulasComboEVP({ combos: combos2, capitalClientes: [{ cliente: 'A', ar_medio: 2000 }], capitalSKUs: [{ sku: '1', estoque_valor: 500 }, { sku: '2', estoque_valor: 300 }], k: null });
    const celSemCusto = r.celulas.find((c) => c.sku === '2')!;
    expect(celSemCusto.cm).toBeNull();      // custo ausente
    expect(celSemCusto.evp).toBeNull();
    expect(celSemCusto.encargo).toBeNull(); // hurdle ausente
    expect(r.porCliente[0].cm).toBe(500);   // só a célula com custo
    expect(r.porCliente[0].encargo).toBeNull();
    expect(r.porCliente[0].encargo_total).toBeNull();
    expect(r.porCliente[0].evp).toBeNull();
  });
});

describe('recomendarAcaoComercial — hurdle_indisponivel', () => {
  const config = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };
  it('hurdle ausente: evp null NÃO dispara "crescer"; "Subir preço" ainda dispara por margem; nota de hurdle presente', () => {
    const r = recomendarAcaoComercial({ evp: null, receita_liquida: 1000, cm: 100, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config, hurdle_indisponivel: true });
    expect(r.some((x) => x.acao === 'Subir preço')).toBe(true); // cm 10% < 15%
    expect(r.some((x) => x.acao === 'Crescer / proteger')).toBe(false);
    expect(r.some((x) => x.acao === 'Configurar hurdle')).toBe(true);
  });
  it('hurdle ausente + desconto excessivo → "Cortar desconto" com motivo hurdle-aware (sem prometer EVP)', () => {
    const r = recomendarAcaoComercial({ evp: null, receita_liquida: 800, cm: 500, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config, hurdle_indisponivel: true });
    const corte = r.find((x) => x.acao === 'Cortar desconto');
    expect(corte).toBeTruthy();
    expect(corte!.motivo.toLowerCase()).toContain('lucro econômico indisponível');
  });
  it('hurdle presente (default): comportamento atual — evp>0 → "Crescer"', () => {
    const r = recomendarAcaoComercial({ evp: 50, receita_liquida: 1000, cm: 300, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config });
    expect(r.some((x) => x.acao === 'Crescer / proteger')).toBe(true);
    expect(r.some((x) => x.acao === 'Configurar hurdle')).toBe(false);
  });
  it('REGRESSÃO (Codex P1.1): hurdle PRESENTE + evp null por CUSTO ausente + desconto>max → "Cortar desconto" AINDA aparece (sem nota de hurdle)', () => {
    const r = recomendarAcaoComercial({ evp: null, cm: null, receita_liquida: 800, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config });
    expect(r.some((x) => x.acao === 'Cortar desconto')).toBe(true); // comportamento conservador atual preservado
    expect(r.some((x) => x.acao === 'Configurar hurdle')).toBe(false); // hurdle presente
    const corte = r.find((x) => x.acao === 'Cortar desconto')!;
    expect(corte.motivo.toLowerCase()).toContain('não gera valor'); // motivo ORIGINAL (não o hurdle-aware)
  });
});

describe('scoreConfiancaCockpit — hurdle_indisponivel', () => {
  it('hurdle ausente → baixa + motivo', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, hurdle_indisponivel: true });
    expect(r.nivel).toBe('baixa');
    expect(r.motivos.some((m) => m.toLowerCase().includes('hurdle'))).toBe(true);
  });
});
```

- [ ] **Step 2 — Rodar, falhar:** `heavy bun run test src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`

- [ ] **Step 3 — Implementar** em `valor-cockpit-helpers.ts`:

```ts
function numOrNull(x: unknown): number | null {
  if (x == null || typeof x === 'boolean' || Array.isArray(x)) return null;
  if (typeof x !== 'number' && typeof x !== 'string') return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
// Hurdle (Ke) do cockpit: âncora + prêmios da fin_valor_inputs.ke.base. Ausente/inválido → null
// (NÃO fabrica 0.20). Âncora obrigatória; prêmio ausente = 0 (legítimo); soma ≤0 → null (0% = grátis).
export function resolverHurdleCockpit(vi: Record<string, unknown> | null | undefined): number | null {
  const ke = ((vi?.ke as Record<string, unknown> | undefined)?.base) as Record<string, unknown> | undefined;
  if (!ke) return null;
  const ancora = numOrNull(ke.ancora);
  if (ancora == null) return null;
  const soma = ancora + (numOrNull(ke.premio_risco_equity) ?? 0) + (numOrNull(ke.premio_tamanho_private) ?? 0) + (numOrNull(ke.premio_iliquidez_controle) ?? 0);
  return Number.isFinite(soma) && soma > 0 ? soma : null;
}
```
`CelulaEVP.encargo` → `number | null`; `RollupCliente`/`RollupSKU`/`empresa`: `encargo: number | null; encargo_total: number | null`. `montarCelulasComboEVP` input `k: number | null`. Célula:
```ts
const encargo = input.k == null ? null : input.k * (a_cs + i_cs);
const evp = (cm == null || encargo == null) ? null : cm - encargo;
```
Rollup null-aware (cada `acc` ganha `encargoNull:true, encargoTotalNull:true`):
```ts
if (cel.encargo != null) { acc.encargoTotal += cel.encargo; acc.encargoTotalNull = false; }
if (cel.cm != null) { acc.cm += cel.cm; acc.cmNull = false; if (cel.encargo != null) { acc.encargo += cel.encargo; acc.encargoNull = false; } }
if (cel.evp != null) { acc.evp += cel.evp; acc.evpNull = false; }
// saída: encargo: a.encargoNull ? null : a.encargo, encargo_total: a.encargoTotalNull ? null : a.encargoTotal
```
Empresa idem (flags `encNull`/`encTotalNull`). `scoreConfiancaCockpit` + input `hurdle_indisponivel?: boolean` → `if (input.hurdle_indisponivel) rebaixar(1, 'Sem Ke/hurdle configurado — lucro econômico (EVP) indisponível; configure em /financeiro/valor.');`. `recomendarAcaoComercial` + input `hurdle_indisponivel?: boolean` com `evpConhecivel = !hurdle_indisponivel` (ver spec D: cortar-desconto motivo hurdle-aware; prazo/despriorizar gated por evpConhecivel; subir-preço inalterada; nota "Configurar hurdle").

- [ ] **Step 4 — Rodar, passar.** `heavy bun run test src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`
- [ ] **Step 5 — Commit:** `feat(valor-cockpit): resolverHurdleCockpit + encargo/evp null-aware + recomendações gated (TDD)`

---

### Task 2: Espelho no edge `fin-valor-cockpit` + contrato

**Files:** Modify `supabase/functions/fin-valor-cockpit/index.ts`; `src/services/financeiroService.ts`

- [ ] **Step 1 — Edge helpers:** copiar `numOrNull` + `resolverHurdleCockpit` verbatim; espelhar as mudanças de `montarCelulasComboEVP`/`recomendarAcaoComercial`/`scoreConfiancaCockpit` (a edge tem as funções inline — bater verbatim).
- [ ] **Step 2 — Edge wire:** L203-204 `const keBase=...; const k = keBase ? (...) : 0.20;` → `const k = resolverHurdleCockpit(vi); const hurdle_indisponivel = k == null;`. Passar `hurdle_indisponivel` a `montarCelulasComboEVP` (k já é null), `recomendarAcaoComercial` (L308) e `scoreConfiancaCockpit` (L318). Expor `hurdle_indisponivel` no result (k já exposto).
- [ ] **Step 3 — `deno check`:** `cd supabase/functions/fin-valor-cockpit && deno check index.ts`.
- [ ] **Step 4 — Contrato** `ValorCockpitResult`: `k: number | null`; `encargo`/`encargo_total` (célula L944-946, rollup L953-955, empresa L965) → `number | null`; **novo** `hurdle_indisponivel: boolean`.
- [ ] **Step 5 — Commit:** `feat(valor-cockpit): edge usa resolverHurdleCockpit (espelho) + contrato nullable`

---

### Task 3: UI `FinanceiroValorCockpit.tsx`

- [ ] **Step 1:** L85 — guard `data.k`: quando `data.k != null`, "… @ {(data.k*100).toFixed(1)}%"; quando null, banner `text-status-warning` "Lucro econômico (EVP) indisponível — configure o Ke/hurdle em /financeiro/valor." (sem `data.k*100`). `brl(encargo/evp)` já renderiza "—". **(Codex P3.6)** L140-141: a cor do EVP cai em `success` (verde) quando `evp==null` (fallback) — trocar p/ neutro: `row.evp == null ? 'text-muted-foreground' : row.evp < 0 ? 'text-status-error' : 'text-status-success'` (não pintar "bom" o que é indisponível).
- [ ] **Step 2 — tsc:** `bunx tsc --noEmit -p tsconfig.app.json`.
- [ ] **Step 3 — Commit:** `feat(valor-cockpit): UI sem "@ 20%" fabricado — banner de hurdle ausente`

---

### Task 4: Docs + validação + Codex adversarial + PR + deploy + CLAUDE.md

- [ ] Doc em `docs/FINANCEIRO_CONFIABILIDADE.md` (A3: hurdle ausente ≠ 20%).
- [ ] Validação: `heavy bun run test` + `heavy bun run typecheck:strict` + `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` + `heavy bun run build`.
- [ ] Codex adversarial no diff (coerção null nos acumuladores, espelho edge≡helper, recomendações, UI).
- [ ] PR + auto-merge `--squash --auto`.
- [ ] Instrução de deploy do `fin-valor-cockpit` via Lovable (verbatim, sem migration).
- [ ] Registrar no CLAUDE.md §5 (housekeeping).
