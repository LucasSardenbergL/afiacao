# Cockpit de Valor — EVP-teto marcado (motor) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capital ausente (AR do cliente / estoque do SKU) deixa de ser tratado como R$0; o EVP vira teto declarado (`evp_parcial`) com guards de robustez, recomendações cientes do teto e confiança ponderada por receita.

**Architecture:** Helper TS puro (`valor-cockpit-helpers.ts`) é a fonte de verdade, testado com vitest (TDD + falsificação). A edge Deno (`fin-valor-cockpit/index.ts`) espelha a LÓGICA verbatim (os tipos no edge são inferidos, então só o corpo das funções muda). Deploy da edge é manual pós-merge.

**Tech Stack:** TypeScript strict, vitest, Deno (edge). Spec: `docs/superpowers/specs/2026-06-18-cockpit-evp-teto-marcado-design.md`.

**Convenções:** rodar testes com `heavy bun run test` (semáforo de RAM). Não usar `tsc` cru; usar `heavy bun run typecheck`. Cada task termina em commit.

---

### Task 1: `margemContribuicao` — guard de finitude

**Files:**
- Modify: `src/lib/financeiro/valor-cockpit-helpers.ts:4-7`
- Test: `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts` (describe `margemContribuicao`, ~linha 13)

- [ ] **Step 1: Escrever o teste que falha**

Adicionar ao `describe('margemContribuicao', ...)`:

```ts
it('receita ou quantidade não-finita → null (cm NaN é fabricação)', () => {
  expect(margemContribuicao({ receita_liquida: NaN, custo_unitario: 6, quantidade: 100 })).toBeNull();
  expect(margemContribuicao({ receita_liquida: 1000, custo_unitario: 6, quantidade: Infinity })).toBeNull();
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- valor-cockpit-helpers --run -t "receita ou quantidade"`
Expected: FAIL (recebe NaN, esperava null).

- [ ] **Step 3: Implementar o guard**

Substituir o corpo de `margemContribuicao`:

```ts
export function margemContribuicao(input: { receita_liquida: number; custo_unitario: number | null; quantidade: number }): number | null {
  if (input.custo_unitario == null || !Number.isFinite(input.custo_unitario)) return null;
  if (!Number.isFinite(input.receita_liquida) || !Number.isFinite(input.quantidade)) return null;
  const m = input.receita_liquida - input.custo_unitario * input.quantidade;
  return Number.isFinite(m) ? m : null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test -- valor-cockpit-helpers --run`
Expected: PASS (todos verdes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "fix(cockpit): margemContribuicao retorna null se cm não-finito (anti-NaN)"
```

---

### Task 2: `montarCelulasComboEVP` — guards (k, capital) + `evp_parcial` na célula

**Files:**
- Modify: `src/lib/financeiro/valor-cockpit-helpers.ts` — tipo `CelulaEVP` (~125-129) e o corpo de `montarCelulasComboEVP` (~142-173)
- Test: mesmo arquivo de teste

- [ ] **Step 1: Escrever os testes que falham**

Adicionar um novo `describe`:

```ts
describe('montarCelulasComboEVP — guards + evp_parcial (teto)', () => {
  const base = {
    combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }], // cm 400
    capitalClientes: [{ cliente: 'C1', ar_medio: 600 }],
    capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }],
    k: 0.2,
  };
  it('estoque ausente + cm + k → evp numérico (teto) E evp_parcial=true', () => {
    const r = montarCelulasComboEVP({ ...base, capitalSKUs: [{ sku: 'S1', estoque_valor: null }] });
    const c = r.celulas[0];
    expect(c.evp).not.toBeNull();
    expect(c.evp_parcial).toBe(true);
    expect(c.estoque_indisponivel).toBe(true);
  });
  it('AR ausente → evp_parcial=true', () => {
    const r = montarCelulasComboEVP({ ...base, capitalClientes: [{ cliente: 'C1', ar_medio: null }] });
    expect(r.celulas[0].evp_parcial).toBe(true);
  });
  it('célula limpa (AR+estoque ok) → evp_parcial=false', () => {
    expect(montarCelulasComboEVP(base).celulas[0].evp_parcial).toBe(false);
  });
  it('estoque_valor=0 CONHECIDO → evp_parcial=false (zero conhecido ≠ ausente)', () => {
    const r = montarCelulasComboEVP({ ...base, capitalSKUs: [{ sku: 'S1', estoque_valor: 0 }] });
    expect(r.celulas[0].estoque_indisponivel).toBe(false);
    expect(r.celulas[0].evp_parcial).toBe(false);
  });
  it('k inválido (k<0 / NaN / 0) → encargo e evp null (não fabrica piso)', () => {
    for (const k of [-0.1, NaN, 0]) {
      const r = montarCelulasComboEVP({ ...base, k });
      expect(r.celulas[0].encargo).toBeNull();
      expect(r.celulas[0].evp).toBeNull();
      expect(r.celulas[0].evp_parcial).toBe(false); // sem evp não há teto
    }
  });
  it('capital negativo ou não-finito → indisponível (não número sujo; teto não vira piso)', () => {
    const neg = montarCelulasComboEVP({ ...base, capitalSKUs: [{ sku: 'S1', estoque_valor: -500 }] });
    expect(neg.celulas[0].estoque_indisponivel).toBe(true);
    expect(neg.celulas[0].i_cs).toBe(0);
    expect(neg.celulas[0].evp_parcial).toBe(true);
    const nan = montarCelulasComboEVP({ ...base, capitalClientes: [{ cliente: 'C1', ar_medio: NaN }] });
    expect(nan.celulas[0].ar_indisponivel).toBe(true);
    expect(nan.celulas[0].a_cs).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- valor-cockpit-helpers --run -t "guards + evp_parcial"`
Expected: FAIL (campo `evp_parcial` inexistente / capital negativo entra como número).

- [ ] **Step 3: Adicionar `evp_parcial` ao tipo `CelulaEVP`**

```ts
export type CelulaEVP = {
  cliente: string; sku: string; receita_liquida: number; quantidade: number;
  cm: number | null; a_cs: number; i_cs: number; encargo: number | null; evp: number | null;
  ar_indisponivel: boolean; estoque_indisponivel: boolean; evp_parcial: boolean;
};
```

- [ ] **Step 4: Reescrever o início de `montarCelulasComboEVP` (guard de k) e o `.map` das células**

Logo após a assinatura `}): ComboEVPResult {`, inserir o guard de `k` antes dos `Map`:

```ts
  // Guard de hurdle: k inválido (não-finito ou <=0) → indisponível (NÃO fabrica encargo).
  // 0% = capital grátis; resolverHurdleCockpit já barra — isto é defense-in-depth na fronteira (Codex 2026-06-18).
  const k = input.k != null && Number.isFinite(input.k) && input.k > 0 ? input.k : null;
```

Substituir o corpo do `const celulas: CelulaEVP[] = input.combos.map((c) => { ... })` por:

```ts
  const celulas: CelulaEVP[] = input.combos.map((c) => {
    const cm = margemContribuicao({ receita_liquida: c.receita_liquida, custo_unitario: c.custo_unitario, quantidade: c.quantidade });
    const arCraw = arPorCliente.get(c.cliente) ?? null;
    const estSraw = estoquePorSKU.get(c.sku) ?? null;
    // Capital válido só se finito e >=0. Negativo/NaN do banco → indisponível (NÃO número sujo):
    // somar uma perna negativa REDUZIRIA o encargo e o "teto" viraria piso (Codex 2026-06-18).
    const arC = arCraw != null && Number.isFinite(arCraw) && arCraw >= 0 ? arCraw : null;
    const estS = estSraw != null && Number.isFinite(estSraw) && estSraw >= 0 ? estSraw : null;
    const rc = receitaPorCliente.get(c.cliente) ?? 0;
    const qs = qtdPorSKU.get(c.sku) ?? 0;
    const ar_indisponivel = arC == null || rc <= 0;
    const estoque_indisponivel = estS == null || qs <= 0;
    const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;
    const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;
    const encargo = k == null ? null : k * (a_cs + i_cs);
    const evp = cm == null || encargo == null ? null : cm - encargo;
    // EVP existe mas alguma perna de capital indisponível → encargo é piso → evp é TETO (upper bound).
    const evp_parcial = evp != null && (ar_indisponivel || estoque_indisponivel);
    return { cliente: c.cliente, sku: c.sku, receita_liquida: c.receita_liquida, quantidade: c.quantidade, cm, a_cs, i_cs, encargo, evp, ar_indisponivel, estoque_indisponivel, evp_parcial };
  });
```

(Nota: as referências a `input.k` nos rollups/empresa adiante NÃO existem — o `k` local substitui só dentro do `.map`. Verificar que nenhum outro ponto da função usa `input.k`; usa só no encargo das células, já trocado.)

- [ ] **Step 5: Rodar e ver passar**

Run: `heavy bun run test -- valor-cockpit-helpers --run`
Expected: PASS (o teste antigo "AR do cliente null → a_cs 0 + flag ar_indisponivel" continua verde; será reforçado na Task 3).

- [ ] **Step 6: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(cockpit): evp_parcial por célula + guards de k/capital (ausente≠zero, anti-piso)"
```

---

### Task 3: rollups + empresa — `evp_parcial`, `cm_incompleto`, `evp_teto_receita_pct`

**Files:**
- Modify: `valor-cockpit-helpers.ts` — tipos `RollupCliente`/`RollupSKU` (~133-134), `ComboEVPResult` (~135-140), corpo do `rollup` (~175-191), mapeamentos `porCliente`/`porSKU` (~195-196) e o bloco `empresa` (~198-205)
- Test: mesmo arquivo

- [ ] **Step 1: Escrever os testes que falham**

```ts
describe('montarCelulasComboEVP — rollup parcial + evp_teto_receita_pct', () => {
  const combos = [
    { cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }, // limpa, cm 400
    { cliente: 'C1', sku: 'S2', receita_liquida: 1000, quantidade: 50, custo_unitario: 10 },  // S2 sem estoque → teto
  ];
  const capCli = [{ cliente: 'C1', ar_medio: 600 }];
  const capSku = [{ sku: 'S1', estoque_valor: 800 }]; // S2 ausente
  it('rollup do cliente marca evp_parcial=true se QUALQUER célula é teto; soma normal', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    const rc = r.porCliente.find((x) => x.cliente === 'C1')!;
    expect(rc.evp_parcial).toBe(true);
    expect(rc.evp).toBeCloseTo((r.celulas[0].evp ?? 0) + (r.celulas[1].evp ?? 0), 6); // identidade
    expect(rc.cm_incompleto).toBe(false); // ambas têm cm
  });
  it('cm_incompleto=true quando o grupo tem célula sem custo', () => {
    const r = montarCelulasComboEVP({
      combos: [...combos, { cliente: 'C1', sku: 'S3', receita_liquida: 500, quantidade: 10, custo_unitario: null }],
      capitalClientes: capCli, capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }, { sku: 'S2', estoque_valor: 400 }, { sku: 'S3', estoque_valor: 100 }], k: 0.2,
    });
    expect(r.porCliente[0].cm_incompleto).toBe(true);
  });
  it('evp_teto_receita_pct ponderado por receita (S2 teto = 1000 de 2000) = 0.5', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    expect(r.evp_teto_receita_pct).toBeCloseTo(0.5, 6);
  });
  it('sem EVP (k=null) → evp_teto_receita_pct = 0 (denominador 0)', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: null });
    expect(r.evp_teto_receita_pct).toBe(0);
    expect(r.empresa.evp_parcial).toBe(false);
  });
  it('empresa.evp_parcial e cm_incompleto agregam o global', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    expect(r.empresa.evp_parcial).toBe(true);
    expect(r.empresa.cm_incompleto).toBe(false);
  });
});
```

Também **reforçar o teste existente** "AR do cliente null → a_cs 0 + flag ar_indisponivel" (adicionar uma linha):

```ts
    expect(c1.evp_parcial).toBe(true); // AR ausente → célula é teto
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- valor-cockpit-helpers --run -t "rollup parcial"`
Expected: FAIL (`evp_parcial`/`cm_incompleto`/`evp_teto_receita_pct` inexistentes).

- [ ] **Step 3: Atualizar os tipos**

```ts
export type RollupCliente = { cliente: string; receita: number; cm: number | null; encargo: number | null; encargo_total: number | null; evp: number | null; evp_parcial: boolean; cm_incompleto: boolean };
export type RollupSKU = { sku: string; receita: number; quantidade: number; cm: number | null; encargo: number | null; encargo_total: number | null; evp: number | null; evp_parcial: boolean; cm_incompleto: boolean };
export type ComboEVPResult = {
  celulas: CelulaEVP[];
  porCliente: RollupCliente[];
  porSKU: RollupSKU[];
  empresa: { receita: number; cm: number | null; encargo: number | null; encargo_total: number | null; evp: number | null; evp_parcial: boolean; cm_incompleto: boolean };
  evp_teto_receita_pct: number;
};
```

- [ ] **Step 4: Atualizar o acumulador `rollup`**

Substituir a função interna `rollup` por (mudanças: campos `evpParcial`/`cmIncompleto` no acc; set de `cmIncompleto` quando `cm==null`; OR de `evpParcial` quando célula é teto):

```ts
  const rollup = (keyFn: (c: CelulaEVP) => string) => {
    const m = new Map<string, { receita: number; quantidade: number; cm: number; cmNull: boolean; encargo: number; encargoNull: boolean; encargoTotal: number; encargoTotalNull: boolean; evp: number; evpNull: boolean; evpParcial: boolean; cmIncompleto: boolean }>();
    for (const cel of celulas) {
      const key = keyFn(cel);
      const acc = m.get(key) ?? { receita: 0, quantidade: 0, cm: 0, cmNull: true, encargo: 0, encargoNull: true, encargoTotal: 0, encargoTotalNull: true, evp: 0, evpNull: true, evpParcial: false, cmIncompleto: false };
      acc.receita += cel.receita_liquida;
      acc.quantidade += cel.quantidade;
      if (cel.cm == null) acc.cmIncompleto = true; // grupo tem célula sem margem (excluída do EVP)
      if (cel.encargo != null) { acc.encargoTotal += cel.encargo; acc.encargoTotalNull = false; }
      if (cel.cm != null) {
        acc.cm += cel.cm; acc.cmNull = false;
        if (cel.encargo != null) { acc.encargo += cel.encargo; acc.encargoNull = false; }
      }
      if (cel.evp != null) { acc.evp += cel.evp; acc.evpNull = false; if (cel.evp_parcial) acc.evpParcial = true; }
      m.set(key, acc);
    }
    return m;
  };
```

- [ ] **Step 5: Atualizar `porCliente`/`porSKU`**

```ts
  const porCliente: RollupCliente[] = [...mc.entries()].map(([cliente, a]) => ({ cliente, receita: a.receita, cm: a.cmNull ? null : a.cm, encargo: a.encargoNull ? null : a.encargo, encargo_total: a.encargoTotalNull ? null : a.encargoTotal, evp: a.evpNull ? null : a.evp, evp_parcial: a.evpParcial, cm_incompleto: a.cmIncompleto }));
  const porSKU: RollupSKU[] = [...ms.entries()].map(([sku, a]) => ({ sku, receita: a.receita, quantidade: a.quantidade, cm: a.cmNull ? null : a.cm, encargo: a.encargoNull ? null : a.encargo, encargo_total: a.encargoTotalNull ? null : a.encargoTotal, evp: a.evpNull ? null : a.evp, evp_parcial: a.evpParcial, cm_incompleto: a.cmIncompleto }));
```

- [ ] **Step 6: Atualizar o bloco `empresa` + `evp_teto_receita_pct`**

Substituir o bloco final (a partir de `let cmEmp = 0, ...` até o `return`) por:

```ts
  let cmEmp = 0, cmNull = true, encEmp = 0, encNull = true, encTotalEmp = 0, encTotalNull = true, evpEmp = 0, evpNull = true, recEmp = 0;
  let evpParcialEmp = false, cmIncompletoEmp = false;
  let recTeto = 0, recComEvp = 0; // ponderação por receita do evp_teto_receita_pct
  for (const cel of celulas) {
    recEmp += cel.receita_liquida;
    if (cel.cm == null) cmIncompletoEmp = true;
    if (cel.encargo != null) { encTotalEmp += cel.encargo; encTotalNull = false; }
    if (cel.cm != null) { cmEmp += cel.cm; cmNull = false; if (cel.encargo != null) { encEmp += cel.encargo; encNull = false; } }
    if (cel.evp != null) {
      evpEmp += cel.evp; evpNull = false;
      recComEvp += cel.receita_liquida;
      if (cel.evp_parcial) { evpParcialEmp = true; recTeto += cel.receita_liquida; }
    }
  }
  const evp_teto_receita_pct = recComEvp > 0 ? recTeto / recComEvp : 0;
  return { celulas, porCliente, porSKU, empresa: { receita: recEmp, cm: cmNull ? null : cmEmp, encargo: encNull ? null : encEmp, encargo_total: encTotalNull ? null : encTotalEmp, evp: evpNull ? null : evpEmp, evp_parcial: evpParcialEmp, cm_incompleto: cmIncompletoEmp }, evp_teto_receita_pct };
```

- [ ] **Step 7: Rodar e ver passar**

Run: `heavy bun run test -- valor-cockpit-helpers --run`
Expected: PASS (incluindo o teste de identidade `Σ porCliente.evp = empresa.evp` já existente — a soma numérica não mudou).

- [ ] **Step 8: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(cockpit): rollup evp_parcial/cm_incompleto + evp_teto_receita_pct (ponderado por receita)"
```

---

### Task 4: `recomendarAcaoComercial` — assimetria teto± + "Crescer" qualificado

**Files:**
- Modify: `valor-cockpit-helpers.ts` — assinatura e corpo de `recomendarAcaoComercial` (~217-265)
- Test: mesmo arquivo

- [ ] **Step 1: Escrever os testes que falham**

```ts
describe('recomendarAcaoComercial — assimetria teto± e cm_incompleto', () => {
  const config = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };
  it('evp>0 confiável (não-teto, cobertura completa) → "Crescer / proteger" puro', () => {
    const r = recomendarAcaoComercial({ evp: 300, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config });
    const cresc = r.find((x) => x.acao === 'Crescer / proteger')!;
    expect(cresc).toBeTruthy();
    expect(cresc.motivo).not.toMatch(/confirmar|teto|parcial/i);
  });
  it('evp>0 mas evp_parcial → "Crescer / proteger" QUALIFICADO (não silencia, não afirma)', () => {
    const r = recomendarAcaoComercial({ evp: 300, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config, evp_parcial: true });
    const cresc = r.find((x) => x.acao === 'Crescer / proteger')!;
    expect(cresc).toBeTruthy();
    expect(cresc.motivo.toLowerCase()).toContain('capital');
    expect(cresc.motivo.toLowerCase()).toContain('confirmar');
  });
  it('evp>0 mas cm_incompleto → "Crescer / proteger" qualificado (margem parcial)', () => {
    const r = recomendarAcaoComercial({ evp: 300, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config, cm_incompleto: true });
    const cresc = r.find((x) => x.acao === 'Crescer / proteger')!;
    expect(cresc.motivo.toLowerCase()).toContain('margem');
  });
  it('alerta negativo dispara só com evp<0 CONHECIDO, não evp==null', () => {
    const comNull = recomendarAcaoComercial({ evp: null, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 90, dias_estoque: 200, config });
    expect(comNull.some((x) => x.acao.includes('prazo') || x.acao.includes('Despriorizar'))).toBe(false);
    const comNeg = recomendarAcaoComercial({ evp: -10, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 90, dias_estoque: 200, config });
    expect(comNeg.some((x) => x.acao.includes('prazo'))).toBe(true);
    expect(comNeg.some((x) => x.acao.includes('Despriorizar'))).toBe(true);
  });
  it('desconto>max + evp-teto>0 → "Cortar desconto" (teto não blinda) com motivo "não confirmado"', () => {
    const r = recomendarAcaoComercial({ evp: 50, receita_liquida: 800, cm: 500, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config, evp_parcial: true });
    const corte = r.find((x) => x.acao === 'Cortar desconto')!;
    expect(corte).toBeTruthy();
    expect(corte.motivo.toLowerCase()).toContain('não confirmado');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- valor-cockpit-helpers --run -t "assimetria teto"`
Expected: FAIL (inputs `evp_parcial`/`cm_incompleto` ignorados; "Crescer" não qualifica; alertas disparam com null).

- [ ] **Step 3: Reescrever `recomendarAcaoComercial`**

Substituir a função inteira por (assinatura ganha `evp_parcial?`/`cm_incompleto?`; alertas negativos exigem `evp != null && evp < 0`; desconto considera `evpTeto`; "Crescer" qualifica):

```ts
export function recomendarAcaoComercial(input: {
  evp: number | null;
  receita_liquida: number;
  cm: number | null;
  desconto_total: number;
  prazo_medio_dias: number;
  dias_estoque: number;
  config: CockpitConfig;
  hurdle_indisponivel?: boolean;
  evp_parcial?: boolean;    // EVP é teto (capital de cliente/SKU não medido) → não afirma valor positivo
  cm_incompleto?: boolean;  // grupo tem células sem custo (margem desconhecida em parte)
}): Recomendacao[] {
  const r: Recomendacao[] = [];
  const c = input.config;
  const receitaBruta = input.receita_liquida + input.desconto_total;
  const descontoPct = receitaBruta > 0 ? input.desconto_total / receitaBruta : 0;
  const cmPct = input.cm != null && input.receita_liquida > 0 ? input.cm / input.receita_liquida : null;
  const evpConhecivel = !input.hurdle_indisponivel;
  const evpTeto = !!input.evp_parcial;       // teto>0 NÃO é evidência de valor positivo
  const cmIncompleto = !!input.cm_incompleto;
  const evpNegConhecido = input.evp != null && input.evp < 0; // teto<0 ⟹ real<0 → robusto

  // cortar desconto: desconto acima do máx e (sem hurdle OU valor não justifica OU teto não confirma)
  if (descontoPct > c.desconto_max_pct && (!evpConhecivel || input.evp == null || input.evp <= 0 || evpTeto)) {
    const recupera = input.desconto_total - receitaBruta * c.desconto_max_pct;
    let motivo: string;
    if (!evpConhecivel) motivo = `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% — lucro econômico indisponível (configure o hurdle p/ confirmar).`;
    else if (evpTeto && input.evp != null && input.evp > 0) motivo = `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% — valor econômico não confirmado (capital não medido em parte).`;
    else motivo = `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% e o combo não gera valor.`;
    r.push({ acao: 'Cortar desconto', motivo, impacto_rs: Math.max(0, recupera) });
  }
  // encurtar prazo: prazo acima do alvo e EVP negativo CONHECIDO (evp==null não fabrica ação — Codex)
  if (evpConhecivel && input.prazo_medio_dias > c.prazo_alvo_dias && evpNegConhecido) {
    r.push({ acao: 'Encurtar prazo / exigir antecipado', motivo: `Prazo médio ${input.prazo_medio_dias.toFixed(0)}d > alvo ${c.prazo_alvo_dias}d puxa o custo de capital de giro.`, impacto_rs: null });
  }
  // subir preço: margem% abaixo da mínima (independe do hurdle)
  if (cmPct != null && cmPct < c.margem_minima_pct) {
    const alvoCM = c.margem_minima_pct * input.receita_liquida;
    r.push({ acao: 'Subir preço', motivo: `Margem ${(cmPct * 100).toFixed(0)}% < mínima ${(c.margem_minima_pct * 100).toFixed(0)}%.`, impacto_rs: Math.max(0, alvoCM - (input.cm as number)) });
  }
  // despriorizar/liquidar SKU: estoque alto + EVP negativo CONHECIDO
  if (evpConhecivel && input.dias_estoque > c.dias_estoque_max && evpNegConhecido) {
    r.push({ acao: 'Despriorizar / liquidar estoque', motivo: `${input.dias_estoque.toFixed(0)} dias de estoque > limite ${c.dias_estoque_max}d e o item não gera valor.`, impacto_rs: null });
  }
  // crescer: EVP positivo e nada disparou. Só afirma SEM ressalva se confiável (não-teto E cobertura completa).
  if (r.length === 0 && input.evp != null && input.evp > 0) {
    if (!evpTeto && !cmIncompleto) {
      r.push({ acao: 'Crescer / proteger', motivo: 'Gera valor econômico positivo e sem alertas.', impacto_rs: null });
    } else {
      const ressalvas: string[] = [];
      if (evpTeto) ressalvas.push('capital não medido em parte da carteira (EVP é teto) — confirmar');
      if (cmIncompleto) ressalvas.push('margem desconhecida em parte (custo ausente)');
      r.push({ acao: 'Crescer / proteger', motivo: `Provável valor econômico positivo, a confirmar: ${ressalvas.join('; ')}.`, impacto_rs: null });
    }
  }
  // NOTA: aviso "configure o Ke/hurdle" NÃO entra aqui (estado do cockpit, não ação por cliente) — vive na confiança + banner.
  return r;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test -- valor-cockpit-helpers --run`
Expected: PASS (testes existentes de `recomendarAcaoComercial`/`hurdle_indisponivel` seguem verdes — nenhum passava `evp==null` esperando prazo/estoque; o de regressão de desconto com `evp==null`+cm null cai no `else` "não gera valor").

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(cockpit): recomendação ciente do teto — Crescer qualificado, alerta só com evp<0 conhecido"
```

---

### Task 5: `scoreConfiancaCockpit` — `evp_teto_receita_pct` (fecha o ponto cego)

**Files:**
- Modify: `valor-cockpit-helpers.ts` — assinatura e corpo de `scoreConfiancaCockpit` (~269-293)
- Test: mesmo arquivo

- [ ] **Step 1: Escrever os testes que falham**

```ts
describe('scoreConfiancaCockpit — evp_teto_receita_pct', () => {
  const okBase = { cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false };
  it('teto por receita > 5% → rebaixa para média + motivo', () => {
    const r = scoreConfiancaCockpit({ ...okBase, evp_teto_receita_pct: 0.052 }); // caso Oben
    expect(r.nivel).toBe('media');
    expect(r.motivos.some((m) => m.toLowerCase().includes('teto'))).toBe(true);
  });
  it('0 < teto <= 5% → só motivo, não rebaixa nível', () => {
    const r = scoreConfiancaCockpit({ ...okBase, evp_teto_receita_pct: 0.03 });
    expect(r.nivel).toBe('alta');
    expect(r.motivos.some((m) => m.toLowerCase().includes('teto'))).toBe(true);
  });
  it('teto = 0 → sem motivo de teto, alta', () => {
    const r = scoreConfiancaCockpit({ ...okBase, evp_teto_receita_pct: 0 });
    expect(r.nivel).toBe('alta');
    expect(r.motivos.some((m) => m.toLowerCase().includes('teto'))).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- valor-cockpit-helpers --run -t "evp_teto_receita_pct"`
Expected: FAIL (input ignorado; nível "alta", sem motivo de teto).

- [ ] **Step 3: Adicionar o input e a lógica**

Na assinatura de `scoreConfiancaCockpit`, adicionar o campo opcional:

```ts
  estoque_ausente_pct: number;
  imposto_estimado: boolean;
  hurdle_indisponivel?: boolean;
  evp_teto_receita_pct?: number; // [0,1] fração da receita-com-EVP cujo EVP é teto (capital não medido)
```

E, antes do `if (input.imposto_estimado) ...`, inserir:

```ts
  const tetoPct = input.evp_teto_receita_pct ?? 0;
  if (tetoPct > 0.05) rebaixar(2, `${(tetoPct * 100).toFixed(0)}% do EVP (por receita) é teto — encargo de capital não medido; lucro econômico otimista nessa fatia.`);
  else if (tetoPct > 0) motivos.push(`${(tetoPct * 100).toFixed(1)}% do EVP (por receita) é teto — encargo de capital não medido em parte.`);
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test -- valor-cockpit-helpers --run`
Expected: PASS (todos; os 5 testes antigos de `scoreConfiancaCockpit` não passam o campo → `?? 0` → inalterados).

- [ ] **Step 5: Falsificação (prova que o assert tem dente)**

Trocar temporariamente o limiar `0.05` por `0.15` e rodar:
Run: `heavy bun run test -- valor-cockpit-helpers --run -t "rebaixa para média"`
Expected: FAIL (0.052 < 0.15 → fica "alta"). Reverter para `0.05`, rodar de novo, ver PASS. (Confirma que o limiar de 5% é o que pega o caso Oben — o erro do 15% original.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(cockpit): confiança rebaixa por evp_teto_receita_pct >5% (fecha ponto cego dos 30%)"
```

---

### Task 6: espelhar verbatim no edge + guard `estoque_valor` + fios

**Files:**
- Modify: `supabase/functions/fin-valor-cockpit/index.ts`

- [ ] **Step 1: Espelhar `margemContribuicao`** (linha ~41-44) — aplicar o mesmo guard de finitude da Task 1.

- [ ] **Step 2: Espelhar `montarCelulasComboEVP`** (linha ~125-169) — aplicar o guard de `k` local, o capital validado (`arC`/`estS` finito>=0), `evp_parcial` na célula, e os blocos de rollup/empresa/`evp_teto_receita_pct` das Tasks 2-3. Os objetos literais ganham os campos; **não há tipos nomeados a alterar no edge** (são inferidos via `typeof`).

- [ ] **Step 3: Espelhar `recomendarAcaoComercial`** (linha ~172-185) e `scoreConfiancaCockpit` (linha ~186-198) — corpo das Tasks 4-5, incluindo os params inline novos (`evp_parcial?`, `cm_incompleto?`, `evp_teto_receita_pct?`).

- [ ] **Step 4: Guard de `estoque_valor` na montagem de `capitalSKUs`** (linha ~341-344). Substituir:

```ts
    const capitalSKUs: CapitalSKU[] = [...new Set(combos.map((c) => c.sku))].map((sku) => {
      const e = estoquePorSKU.get(sku);
      // cmc/saldo não-finito → null (NÃO saldo*null=0, que viraria "zero conhecido" e escaparia do teto — Codex)
      const estoque_valor = e && Number.isFinite(e.saldo) && Number.isFinite(e.cmc) ? e.saldo * e.cmc : null;
      return { sku, estoque_valor };
    });
```

- [ ] **Step 5: Passar as flags para `recomendarAcaoComercial`** (linha ~352-355). Adicionar ao objeto:

```ts
      recomendacoes: recomendarAcaoComercial({ evp: rc.evp, receita_liquida: rc.receita, cm: rc.cm, desconto_total: descontoPorCliente.get(rc.cliente) ?? 0, prazo_medio_dias: 0, dias_estoque: 0, config, hurdle_indisponivel, evp_parcial: rc.evp_parcial, cm_incompleto: rc.cm_incompleto }),
```

- [ ] **Step 6: Passar `evp_teto_receita_pct` à confiança** (linha ~371). Substituir:

```ts
    const confianca = scoreConfiancaCockpit({ cobertura_receita, custo_ausente_pct, ar_indisponivel_pct, estoque_ausente_pct, imposto_estimado: true, hurdle_indisponivel, evp_teto_receita_pct: res.evp_teto_receita_pct });
```

- [ ] **Step 7: Expor `evp_teto_receita_pct` no payload** (no `return jsonResponse({...})`, ~373-379). Adicionar a chave:

```ts
      cobertura_baixa_ar: coberturaBaixaAR,
      evp_teto_receita_pct: res.evp_teto_receita_pct, // fração da receita-com-EVP cujo EVP é teto (UI entrega 2)
      config,
```

- [ ] **Step 8: Validar o edge com Deno**

Run: `deno check supabase/functions/fin-valor-cockpit/index.ts`
Expected: 0 erros.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/fin-valor-cockpit/index.ts
git commit -m "feat(cockpit/edge): espelha EVP-teto verbatim + guard estoque_valor (cmc null → null)"
```

---

### Task 7: verificação final + paridade TS↔edge + falsificação de fronteira

**Files:** nenhum (verificação)

- [ ] **Step 1: Suíte completa + typecheck strict**

Run: `heavy bun run test -- valor-cockpit-helpers --run > /tmp/evp-test.log 2>&1; echo "test exit=$?"`
Run: `heavy bun run typecheck > /tmp/evp-tc.log 2>&1; echo "tc exit=$?"`
Expected: ambos exit 0.

- [ ] **Step 2: Paridade helper ↔ edge (inspeção das linhas-chave)**

Conferir que os 4 fragmentos abaixo aparecem IDÊNTICOS nos dois arquivos:

```bash
for f in src/lib/financeiro/valor-cockpit-helpers.ts supabase/functions/fin-valor-cockpit/index.ts; do
  echo "== $f =="
  grep -n "Number.isFinite(input.k) && input.k > 0\|arCraw != null && Number.isFinite(arCraw)\|evp_parcial = evp != null\|recComEvp > 0 ? recTeto / recComEvp" "$f"
done
```
Expected: as 4 linhas presentes nos DOIS arquivos (corpo verbatim).

- [ ] **Step 3: Falsificação de fronteira (capital negativo)**

Temporariamente, no helper, trocar `arCraw >= 0` por `true` (remover o guard de sinal). Rodar:
Run: `heavy bun run test -- valor-cockpit-helpers --run -t "capital negativo"`
Expected: FAIL (capital -500 entraria como número → `estoque_indisponivel=false`). Reverter o guard, rodar de novo → PASS.

- [ ] **Step 4: Commit (se houve ajuste) e fechamento**

Nenhum commit se nada mudou na verificação. Registrar no PR o handoff de deploy:
- Edge `fin-valor-cockpit`: **deploy MANUAL pós-merge** pelo chat do Lovable, lendo `index.ts` da `main` **verbatim**.
- Frontend: **nada** (UI é entrega 2).
- Lembrete: hoje `k=null` (Ke não configurado) → o efeito do EVP-teto só aparece quando o founder ligar o Ke em `/financeiro/valor`.

---

## Self-Review (cobertura da spec)

- Guards de robustez (k, capital, cm, edge estoque_valor): Tasks 1, 2, 6 ✓
- `evp_parcial` célula + propagação rollup/empresa: Tasks 2, 3 ✓
- `evp_teto_receita_pct` ponderado por receita + denominador 0: Task 3 ✓
- Assimetria teto± + "Crescer" qualificado (D1) + `cm_incompleto` (D2): Task 4 ✓
- Confiança fecha ponto cego (limiar 5%): Task 5 ✓
- Espelhamento verbatim TS↔edge + fios + payload: Task 6 ✓
- Falsificação (evp_parcial, guard de sinal, limiar 15%): Tasks 5, 7 ✓
- Identidade contábil preservada: Task 3 (teste existente + novo) ✓
- Deploy manual da edge / UI fora de escopo: Task 7 ✓
