# Cockpit — Caixa inicial da projeção × saldo atual — Plano

> Execução inline com TDD. Client-side puro, sem migration/deploy.

**Goal:** expor no Cockpit o caixa inicial que a projeção consolidada usou vs o saldo bancário atual (`totalCC`), com delta + nota honesta. Não muda nenhum número.

**Spec:** `docs/superpowers/specs/2026-05-31-cockpit-caixa-inicial-design.md`

---

### Task 1: helper `cockpit-consolida-helpers.ts` — TDD

**Files:** Modify `src/lib/financeiro/cockpit-consolida-helpers.ts`; Test `src/lib/financeiro/__tests__/cockpit-consolida-helpers.test.ts`

- [ ] **Step 1 — Testes falhando:**
```ts
import { consolidarCockpit, compararCaixaInicial } from '../cockpit-consolida-helpers';

const wk = (inicio: string, saldo_inicial: number | null, saldo_final = 0) =>
  ({ inicio, total_entradas: 0, total_saidas: 0, saldo_final, saldo_inicial });

describe('consolidarCockpit — caixa_inicial', () => {
  it('soma saldo_inicial da semana de MENOR inicio de cada empresa presente', () => {
    const r = consolidarCockpit({ esperadas: ['oben', 'colacor'], snapshots: [
      { company: 'oben', snapshot_at: '2026-05-31T10:00:00Z', ncg: 0, saldo_tesouraria: 0, semanas: [wk('2026-06-01', 1000), wk('2026-05-25', 500)] },
      { company: 'colacor', snapshot_at: '2026-05-31T10:00:00Z', ncg: 0, saldo_tesouraria: 0, semanas: [wk('2026-05-25', 300)] },
    ] });
    expect(r.caixa_inicial_projecao).toBe(800); // 500 (menor inicio oben) + 300
    expect(r.caixa_inicial_parcial).toBe(false);
  });
  it('empresa presente sem saldo_inicial válido → caixa null + parcial', () => {
    const r = consolidarCockpit({ esperadas: ['oben', 'colacor'], snapshots: [
      { company: 'oben', snapshot_at: '2026-05-31T10:00:00Z', ncg: 0, saldo_tesouraria: 0, semanas: [wk('2026-05-25', 500)] },
      { company: 'colacor', snapshot_at: '2026-05-31T10:00:00Z', ncg: 0, saldo_tesouraria: 0, semanas: [wk('2026-05-25', null)] },
    ] });
    expect(r.caixa_inicial_projecao).toBeNull();
    expect(r.caixa_inicial_parcial).toBe(true);
  });
});

describe('compararCaixaInicial', () => {
  it('coorte completa + caixa presente → delta = saldoAtual − caixaInicial', () => {
    expect(compararCaixaInicial({ caixaInicialProjecao: 800, saldoAtualBanco: 950, cohorteCompleta: true }))
      .toEqual({ disponivel: true, delta: 150 });
  });
  it('coorte incompleta → indisponível (maçã×laranja)', () => {
    expect(compararCaixaInicial({ caixaInicialProjecao: 800, saldoAtualBanco: 950, cohorteCompleta: false }))
      .toEqual({ disponivel: false, delta: null });
  });
  it('caixa inicial null → indisponível', () => {
    expect(compararCaixaInicial({ caixaInicialProjecao: null, saldoAtualBanco: 950, cohorteCompleta: true }))
      .toEqual({ disponivel: false, delta: null });
  });
});
```

- [ ] **Step 2 — Rodar, falhar:** `heavy bun run test src/lib/financeiro/__tests__/cockpit-consolida-helpers.test.ts`

- [ ] **Step 3 — Implementar:**
  - `SnapshotSemana` += `saldo_inicial: number | null`.
  - `CockpitConsolidado` += `caixa_inicial_projecao: number | null; caixa_inicial_por_empresa: { company: string; saldo_inicial: number | null; presente: boolean }[]; caixa_inicial_parcial: boolean;`.
  - Em `consolidarCockpit`, antes do `return` (após a seção 7):
```ts
  // 8. Caixa inicial da projeção (transparência): saldo_inicial da semana de MENOR inicio de cada
  // empresa presente (não semanas[0] literal — robustez se a semana 0 foi filtrada). Σ; null se algum presente faltar.
  const caixa_inicial_por_empresa = esperadas.map((c) => {
    const s = coorte.get(c);
    if (!s) return { company: c, saldo_inicial: null as number | null, presente: false };
    let melhor: { inicio: string; saldo_inicial: number } | null = null;
    for (const w of s.semanas) {
      if (w.saldo_inicial == null || !Number.isFinite(w.saldo_inicial)) continue;
      if (melhor == null || w.inicio < melhor.inicio) melhor = { inicio: w.inicio, saldo_inicial: w.saldo_inicial };
    }
    return { company: c, saldo_inicial: melhor ? melhor.saldo_inicial : null, presente: true };
  });
  let caixaIniRaw = 0;
  let algumCaixaIniNull = false;
  for (const e of caixa_inicial_por_empresa) {
    if (!e.presente) continue;
    if (e.saldo_inicial != null) caixaIniRaw += e.saldo_inicial;
    else algumCaixaIniNull = true;
  }
  const caixa_inicial_parcial = parcial || algumCaixaIniNull;
  const caixa_inicial_projecao = algumCaixaIniNull ? null : round2(caixaIniRaw);
```
  - Adicionar os 3 campos ao objeto de `return`.
  - Helper puro novo (export):
```ts
export function compararCaixaInicial(input: {
  caixaInicialProjecao: number | null;
  saldoAtualBanco: number;
  cohorteCompleta: boolean;
}): { disponivel: boolean; delta: number | null } {
  const disponivel = input.cohorteCompleta && input.caixaInicialProjecao != null;
  return { disponivel, delta: disponivel ? round2(input.saldoAtualBanco - (input.caixaInicialProjecao as number)) : null };
}
```

- [ ] **Step 4 — Rodar, passar.** **Step 5 — Commit.** `feat(cockpit): consolidarCockpit expõe caixa_inicial + compararCaixaInicial (TDD)`

---

### Task 2: service + UI

**Files:** `src/services/financeiroV2Service.ts`, `src/components/financeiro/cockpit/Projecao13Card.tsx`, `src/pages/FinanceiroCockpit.tsx`

- [ ] **Step 1 — Service `getProjecaoSnapshotsCockpit`:** no `.map` da semana, adicionar `saldo_inicial: Number.isFinite(Number(w?.saldo_inicial)) ? Number(w?.saldo_inicial) : null` (NÃO no `.filter` rígido — semana não pode ser dropada por campo só-transparência).
- [ ] **Step 2 — Projecao13Card:** novas props `caixaInicialProjecao: number | null; saldoAtualBanco: number; cohorteCompleta: boolean`. Importar `compararCaixaInicial`. Abaixo dos badges/parágrafos do header:
```tsx
{(() => {
  const cmp = compararCaixaInicial({ caixaInicialProjecao, saldoAtualBanco, cohorteCompleta });
  return cmp.disponivel ? (
    <p className="text-[11px] text-muted-foreground">
      Caixa inicial da projeção: {fmtCompact(caixaInicialProjecao as number)} · saldo bancário atual {fmtCompact(saldoAtualBanco)} · Δ {fmtCompact(cmp.delta as number)} <span className="opacity-70">(a diferença pode refletir movimentações após o snapshot)</span>
    </p>
  ) : (
    <p className="text-[11px] text-muted-foreground">Caixa inicial da projeção indisponível neste snapshot{cohorteCompleta ? '' : ' (projeção parcial)'}.</p>
  );
})()}
```
- [ ] **Step 3 — FinanceiroCockpit:** passar ao `Projecao13Card`: `caixaInicialProjecao={cockpit.caixa_inicial_projecao}` `saldoAtualBanco={totalCC}` `cohorteCompleta={!cockpit.parcial}` (totalCC já é destructurado do hook).
- [ ] **Step 4 — tsc:** `bunx tsc --noEmit -p tsconfig.app.json`. **Step 5 — Commit.** `feat(cockpit): UI mostra caixa inicial da projeção vs saldo atual (transparência)`

---

### Task 3: docs + validação + Codex adversarial + PR + CLAUDE.md

- [ ] Doc em `FINANCEIRO_CONFIABILIDADE.md` (Cockpit: caixa inicial transparente).
- [ ] Validação: `heavy bun run test` + `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` + `heavy bun run build`. (⚠️ a main consolidou o typecheck — só `bun run typecheck`/`tsc -p tsconfig.app.json`; NÃO existe mais `typecheck:strict`.)
- [ ] Codex adversarial no diff.
- [ ] PR + auto-merge `--squash --auto`. **SEM deploy** (client-side; snapshot já grava saldo_inicial).
- [ ] CLAUDE.md §5 (housekeeping). Encerra a frente de consolidação; próximo valor = founder preencher inputs.
