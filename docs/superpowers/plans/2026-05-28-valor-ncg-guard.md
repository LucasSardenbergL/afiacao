# Valor A2 — Guard de NCG indisponível — Plano de implementação

> **Sub-skill:** subagent-driven-development OU execução inline com TDD. Steps em checkbox.

**Goal:** Quando o snapshot de NCG está ausente, o Valor A2 para de fabricar `capital_giro=0`/ROIC superestimado; capital/ROIC/EVA viram `null`, confiança vira `baixa`, e a UI diz "sem snapshot de NCG". Snapshot velho → confiança `media` + visível.

**Arquitetura:** helper TS puro (TDD vitest) espelhado verbatim no Deno `fin-valor-engine`; contrato nullable; UI null-aware. Sem migration. Deploy do edge via Lovable.

**Spec:** `docs/superpowers/specs/2026-05-28-valor-ncg-guard-design.md`

---

### Task 1: Helpers puros + tipos nullable (`valor-helpers.ts`) — TDD

**Files:**
- Modify: `src/lib/financeiro/valor-helpers.ts`
- Test: `src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 1 — Testes falhando** (adicionar ao test existente):

```ts
import { resolverCapitalGiro, frescorGiro, acharCapitalGiroAnterior } from '../valor-helpers';

describe('resolverCapitalGiro', () => {
  it('pega o snapshot mais recente com ncg não-nulo (negativo é real)', () => {
    const r = resolverCapitalGiro([
      { ncg: null, snapshot_at: '2026-05-28T10:00:00Z' },
      { ncg: -5000, snapshot_at: '2026-05-27T10:00:00Z' },
      { ncg: 9999, snapshot_at: '2026-05-20T10:00:00Z' },
    ]);
    expect(r.capital_giro).toBe(-5000);
    expect(r.disponivel).toBe(true);
    expect(r.snapshot_at).toBe('2026-05-27T10:00:00Z');
  });
  it('ncg zero é valor REAL (não ausência)', () => {
    const r = resolverCapitalGiro([{ ncg: 0, snapshot_at: '2026-05-28T10:00:00Z' }]);
    expect(r.capital_giro).toBe(0);
    expect(r.disponivel).toBe(true);
  });
  it('todos null → indisponível', () => {
    const r = resolverCapitalGiro([{ ncg: null, snapshot_at: '2026-05-28T10:00:00Z' }]);
    expect(r.capital_giro).toBeNull();
    expect(r.disponivel).toBe(false);
  });
  it('sem snapshots → indisponível', () => {
    const r = resolverCapitalGiro([]);
    expect(r.disponivel).toBe(false);
    expect(r.snapshot_at).toBeNull();
  });
});

describe('frescorGiro', () => {
  const hoje = Date.parse('2026-05-28T00:00:00Z');
  it('fresco < limiar → não stale', () => {
    expect(frescorGiro('2026-05-20T00:00:00Z', hoje, 45)).toEqual({ dias: 8, stale: false });
  });
  it('velho > limiar → stale', () => {
    const r = frescorGiro('2026-01-01T00:00:00Z', hoje, 45);
    expect(r.stale).toBe(true);
    expect(r.dias).toBeGreaterThan(45);
  });
  it('snapshot_at null → dias null, não stale', () => {
    expect(frescorGiro(null, hoje, 45)).toEqual({ dias: null, stale: false });
  });
});

describe('acharCapitalGiroAnterior', () => {
  it('acha o snapshot ~365d antes do ref dentro da tolerância', () => {
    const snaps = [
      { ncg: 1000, snapshot_at: '2026-05-27T00:00:00Z' },
      { ncg: 800, snapshot_at: '2025-05-26T00:00:00Z' },
    ];
    expect(acharCapitalGiroAnterior(snaps, '2026-05-27T00:00:00Z')).toBe(800);
  });
  it('sem snapshot próximo de −365d → null', () => {
    const snaps = [{ ncg: 1000, snapshot_at: '2026-05-27T00:00:00Z' }];
    expect(acharCapitalGiroAnterior(snaps, '2026-05-27T00:00:00Z')).toBeNull();
  });
});
```
Adicionar também casos em `capitalInvestido`, `normalizarComingling`, `scoreConfiancaValor` (matriz do spec): giro null → `capital_investido:null`+`giro_indisponivel:true`+`parcial:true`; giro 0 real + ativo fixo → capital = ativo fixo, `giro_indisponivel:false`; `normalizarComingling({capital_reportado:null, intercompany_giro:-500,...})` → `capital_normalizado:null` (NÃO −500), `ebit_normalizado` calculado; `scoreConfiancaValor({giro_indisponivel:true,...})` → `baixa`; `{giro_stale:true,...}` → `media`.

- [ ] **Step 2 — Rodar, ver falhar:** `heavy bun run test src/lib/financeiro/__tests__/valor-helpers.test.ts`

- [ ] **Step 3 — Implementar:**

```ts
export type SnapNcg = { ncg: number | null; snapshot_at: string };

export function resolverCapitalGiro(snaps: SnapNcg[]): { capital_giro: number | null; snapshot_at: string | null; disponivel: boolean } {
  // snaps já vêm ordenados desc por snapshot_at; mas não confie — pegue o mais recente com ncg != null.
  let melhor: SnapNcg | null = null;
  for (const s of snaps) {
    if (s.ncg == null) continue;
    if (melhor == null || Date.parse(s.snapshot_at) > Date.parse(melhor.snapshot_at)) melhor = s;
  }
  if (melhor == null) return { capital_giro: null, snapshot_at: null, disponivel: false };
  return { capital_giro: Number(melhor.ncg), snapshot_at: melhor.snapshot_at, disponivel: true };
}

export function frescorGiro(snapshot_at: string | null, hojeMs: number, limiarStaleDias = 45): { dias: number | null; stale: boolean } {
  if (!snapshot_at) return { dias: null, stale: false };
  const t = Date.parse(snapshot_at);
  if (!Number.isFinite(t)) return { dias: null, stale: false };
  const dias = Math.round((hojeMs - t) / 86400000);
  return { dias, stale: dias > limiarStaleDias };
}

export function acharCapitalGiroAnterior(snaps: SnapNcg[], refSnapshotAt: string, opts?: { janelaDias?: number; toleranciaDias?: number }): number | null {
  const janela = opts?.janelaDias ?? 365;
  const tol = opts?.toleranciaDias ?? 60;
  const alvo = Date.parse(refSnapshotAt) - janela * 86400000;
  let melhor: { ncg: number; dist: number } | null = null;
  for (const s of snaps) {
    if (s.ncg == null) continue;
    const dist = Math.abs(Date.parse(s.snapshot_at) - alvo);
    if (melhor == null || dist < melhor.dist) melhor = { ncg: Number(s.ncg), dist };
  }
  return melhor && melhor.dist <= tol * 86400000 ? melhor.ncg : null;
}
```

`capitalInvestido` — `capital_giro: number | null`; result `capital_investido: number | null`, `capital_giro: number | null`, novo `giro_indisponivel: boolean`:
```ts
export function capitalInvestido(input: { capital_giro: number | null; ativo_fixo: AtivoFixoInput; ajustes?: number; }): CapitalInvestidoResult {
  const ajustes = input.ajustes ?? 0;
  const motivos: string[] = [];
  let ativo_fixo = 0;
  let parcial = false;
  const giro_indisponivel = input.capital_giro == null;
  if (input.ativo_fixo && input.ativo_fixo.operacional && Number.isFinite(input.ativo_fixo.valor)) {
    ativo_fixo = input.ativo_fixo.valor;
  } else {
    parcial = true;
    motivos.push('Ativo fixo operacional não informado — capital investido parcial (só giro − ajustes).');
  }
  if (giro_indisponivel) {
    parcial = true;
    motivos.push('Sem snapshot de NCG — capital de giro indisponível; ROIC/EVA não calculáveis.');
    return { capital_investido: null, capital_giro: null, ativo_fixo, ajustes, parcial, giro_indisponivel: true, motivos };
  }
  const capital_investido = (input.capital_giro as number) + ativo_fixo - ajustes;
  return { capital_investido, capital_giro: input.capital_giro, ativo_fixo, ajustes, parcial, giro_indisponivel: false, motivos };
}
```
(Atualizar `CapitalInvestidoResult`: `capital_investido: number | null; capital_giro: number | null; giro_indisponivel: boolean`.)

`normalizarComingling` — `capital_reportado: number | null` → `capital_normalizado: number | null` com guard:
```ts
const capital_normalizado = input.capital_reportado == null ? null : input.capital_reportado + ajuste_intercompany_capital;
```
(Atualizar tipo `CominglingResult.capital_reportado: number | null; capital_normalizado: number | null`.)

`scoreConfiancaValor` — novos inputs `giro_indisponivel?: boolean`, `giro_stale?: boolean`:
```ts
if (input.giro_indisponivel) rebaixar(1, 'Sem snapshot de NCG — capital de giro indisponível; ROIC/EVA não calculáveis.');
else if (input.giro_stale) rebaixar(2, 'NCG desatualizado (snapshot antigo) — capital de giro pode estar defasado.');
```

**Composta `resolverCapitalParaValor` (Codex plano P1.1 — defeita o "inline 0"):** encapsula TODO o bloco de capital (hoje inline no edge L244-298), pra ser testável ponta-a-ponta e espelhada verbatim — o edge NÃO pode mais ter `capital_giro = latestNcg ? ... : 0` inline:
```ts
export function resolverCapitalParaValor(input: {
  snaps: SnapNcg[]; ativo_fixo: AtivoFixoInput; ajustes?: number; hojeMs: number; limiarStaleDias?: number;
}): {
  capital: CapitalInvestidoResult;        // capital_investido/capital_giro number|null + giro_indisponivel
  capital_anterior: number | null;        // capital investido do ponto −12m (null se giro atual indisponível)
  giro_snapshot_at: string | null; giro_dias: number | null; giro_stale: boolean;
} {
  const giro = resolverCapitalGiro(input.snaps);
  const frescor = frescorGiro(giro.snapshot_at, input.hojeMs, input.limiarStaleDias);
  const capital = capitalInvestido({ capital_giro: giro.capital_giro, ativo_fixo: input.ativo_fixo, ajustes: input.ajustes });
  const capital_giro_anterior = giro.disponivel && giro.snapshot_at ? acharCapitalGiroAnterior(input.snaps, giro.snapshot_at) : null;
  const capital_anterior = capital_giro_anterior != null
    ? capitalInvestido({ capital_giro: capital_giro_anterior, ativo_fixo: input.ativo_fixo, ajustes: input.ajustes }).capital_investido
    : null;
  return { capital, capital_anterior, giro_snapshot_at: giro.snapshot_at, giro_dias: frescor.dias, giro_stale: frescor.stale };
}
```

**Testes de orquestração da composta (Codex P1.1 + P1.3 — asserts EXATOS):**
```ts
describe('resolverCapitalParaValor', () => {
  const hoje = Date.parse('2026-05-28T00:00:00Z');
  const af = null; // sem ativo fixo
  it('NCG ausente (todos null) → capital_investido/capital_giro null, giro_indisponivel, sem anterior', () => {
    const r = resolverCapitalParaValor({ snaps: [{ ncg: null, snapshot_at: '2026-05-28T00:00:00Z' }], ativo_fixo: af, hojeMs: hoje });
    expect(r.capital.capital_investido).toBeNull();
    expect(r.capital.capital_giro).toBeNull();
    expect(r.capital.giro_indisponivel).toBe(true);
    expect(r.capital_anterior).toBeNull();
  });
  it('NCG negativo grande + sem ativo fixo → giro DISPONÍVEL mas capital_investido ≤ 0 (roic null por capital, NÃO por ausência)', () => {
    const r = resolverCapitalParaValor({ snaps: [{ ncg: -50000, snapshot_at: '2026-05-27T00:00:00Z' }], ativo_fixo: af, hojeMs: hoje });
    expect(r.capital.giro_indisponivel).toBe(false);
    expect(r.capital.capital_investido).toBe(-50000);
    expect(roic({ nopat: 1000, capital_investido: r.capital.capital_investido })).toBeNull(); // capital≤0
  });
  it('NCG válido recente → capital_giro = ncg (happy-path idêntico), não stale', () => {
    const r = resolverCapitalParaValor({ snaps: [{ ncg: 300000, snapshot_at: '2026-05-25T00:00:00Z' }], ativo_fixo: af, hojeMs: hoje });
    expect(r.capital.capital_giro).toBe(300000);
    expect(r.giro_stale).toBe(false);
  });
});
```
Confiança: `scoreConfiancaValor({giro_indisponivel:true,...}).nivel === 'baixa'` (exato); `{giro_stale:true,...}.nivel === 'media'`; capital≤0 conhecido (`roic_null:true, giro_indisponivel:false`) → `'media'` (distinção P1.3). Normalização: `normalizarComingling({capital_reportado:null, intercompany_giro:-500,...}).capital_normalizado === null` (NÃO −500) e `.ebit_normalizado` calculado.

- [ ] **Step 4 — Rodar, ver passar.** `heavy bun run test src/lib/financeiro/__tests__/valor-helpers.test.ts`
- [ ] **Step 5 — Commit:** `feat(valor): helpers resolverCapitalGiro/frescorGiro/resolverCapitalParaValor + capital/comingling/confiança null-aware (TDD)`

---

### Task 2: Espelho no edge `fin-valor-engine` + contrato

**Files:**
- Modify: `supabase/functions/fin-valor-engine/index.ts` (L244-340)
- Modify: `src/services/financeiroService.ts` (L831-854)

- [ ] **Step 1 — Edge:** copiar verbatim TODOS os helpers novos/alterados (`resolverCapitalGiro`, `frescorGiro`, `acharCapitalGiroAnterior`, **`resolverCapitalParaValor`**, `capitalInvestido`, `normalizarComingling`, `scoreConfiancaValor`) para a seção de helpers do `index.ts`. Substituir L244-298 (bloco de capital inteiro) por **uma** chamada à composta:
```ts
const { data: snaps } = await db.from("fin_projecao_snapshots")
  .select("ncg, snapshot_at").eq("company", company).order("snapshot_at", { ascending: false }).limit(400);
const snapRows = (snaps ?? []) as Array<{ ncg: number | null; snapshot_at: string }>;
const cap = resolverCapitalParaValor({ snaps: snapRows, ativo_fixo, ajustes, hojeMs: Date.now() });
const capRep = cap.capital;            // {capital_investido, capital_giro, ..., giro_indisponivel}
const capAnterior = cap.capital_anterior;
```
**NÃO** deixar nenhum `capital_giro = latestNcg ? ... : 0` inline (Codex P1.1 — defeitado pela composta).
- [ ] **Step 2 — Edge wire:** `normalizarComingling({ ebit_reportado: nopatAtual.ebit, capital_reportado: capRep.capital_investido, ... })` (agora aceita null). `scoreConfiancaValor({ ..., giro_indisponivel: capRep.giro_indisponivel, giro_stale: cap.giro_stale })`. **Remover** o motivo enterrado da L340. Expor no result: `giro_indisponivel: capRep.giro_indisponivel`, `giro_snapshot_at: cap.giro_snapshot_at`, `giro_dias: cap.giro_dias`. **Auditar coerção null (Codex P1.2)** em todos os sites: `roic/eva/incremental` (já null-safe), `cg/roicNorm/evaNorm` (guard na composta/comingling), `result` (`normalizado.capital_investido = cg.capital_normalizado` pode ser null — contrato nullable).
- [ ] **Step 3 — `deno check`:** `cd supabase/functions/fin-valor-engine && deno check index.ts` (erro-set inalterado).
- [ ] **Step 4 — Contrato** `ValorEmpresaResult`: `reportado.capital_investido: number | null; capital_giro: number | null; giro_indisponivel: boolean; giro_snapshot_at: string | null; giro_dias: number | null;` e `normalizado.capital_investido: number | null;`.
- [ ] **Step 5 — Commit:** `feat(valor): fin-valor-engine usa guard de NCG (espelho) + contrato nullable`

---

### Task 3: UI `FinanceiroValor.tsx`

**Files:** Modify `src/pages/FinanceiroValor.tsx`

- [ ] **Step 1 — Mensagens:** gate L48 → `data.reportado.capital_parcial && !data.reportado.giro_indisponivel && modo === 'reportado'` (não dizer "sem ativo fixo" quando o parcial vem do NCG). Adicionar, quando `data.reportado.giro_indisponivel && modo === 'reportado'`: `<p className="text-xs text-status-warning">Sem snapshot de NCG — capital de giro indisponível (rode a projeção de caixa). ROIC/EVA não calculáveis.</p>`.
- [ ] **Step 2 — Frescor:** quando `reportado.giro_snapshot_at`, exibir "NCG de DD/MM/YYYY" + "(Nd atrás)" se `giro_dias != null && giro_dias > 1`, com `text-status-warning` quando muito defasado (espelha `Projecao13Card`).
- [ ] **Step 3 — tsc:** `bunx tsc --noEmit -p tsconfig.app.json` (capital_investido/capital_giro null já passam por `brl()`).
- [ ] **Step 4 — Commit:** `feat(valor): UI distingue giro indisponível de ativo-fixo parcial + frescor do NCG`

---

### Task 4: Docs + validação + Codex adversarial + PR + deploy + CLAUDE.md

- [ ] **Step 1 — Docs:** seção em `docs/FINANCEIRO_CONFIABILIDADE.md` (Valor A2: NCG ausente ≠ R$0; staleness; reconciliação com Cockpit).
- [ ] **Step 2 — Validação completa:** `heavy bun run test` + `heavy bun run typecheck:strict` + `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` + `heavy bun run build`.
- [ ] **Step 3 — Codex adversarial** no diff (`/codex` consult): foco em coerção null, staleness, espelho edge≡helper, confiança.
- [ ] **Step 4 — PR + auto-merge** `--squash --auto`; CI `validate`.
- [ ] **Step 5 — Deploy:** instrução pro founder colar no chat do Lovable (ler `supabase/functions/fin-valor-engine/index.ts` do repo, deploy verbatim). **Sem migration.**
- [ ] **Step 6 — CLAUDE.md §5:** registrar (PR de housekeeping).
