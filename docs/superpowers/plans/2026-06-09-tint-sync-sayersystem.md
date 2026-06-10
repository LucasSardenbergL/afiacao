# Tint Sync SayerSystem — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar o upload manual de CSV do tintométrico — conector lê o PostgreSQL local do SayerSystem e o servidor promove staging→oficial com regra de 3, preço reproduzido e desativação segura.

**Architecture:** Conector Go "burro e fiel" (serviço Windows, delta por `data_atualizacao` com high-water mark da origem) → edge `tint-sync-agent` existente (staging) → promoção SQL nova `tint_promote_sync_run` (latest-staging-por-chave, expansão por embalagem vendável, recálculo de preço por insumo, keys-snapshot com blast-radius guard). Spec: `docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md` (LER §6 e §11 antes de qualquer task).

**Tech Stack:** SQL/plpgsql (migration manual via SQL Editor — §5 CLAUDE.md), Deno edge (deploy via chat Lovable), helper TS puro + vitest (oráculo), PG17 local (`db/test-tint-promote.sh`), Go 1.22+ (conector, cross-compile windows/amd64).

**⚠️ Regras da casa:** migrations NÃO se auto-aplicam (entregar bloco SQL inline pro founder); edge deploy é manual pós-merge; `bun run test` (não `bun test`) é o canônico; `heavy` nos comandos pesados se houver sessões paralelas; NUNCA `> log | tail` (engole exit code).

---

## PR1 — Servidor (promoção + endurecimentos + contrato)

### Task 1: Helper puro `sync-promote.ts` (oráculo TDD da regra de 3 + preço + blast radius)

**Files:**
- Create: `src/lib/tint/sync-promote.ts`
- Create: `src/lib/tint/__tests__/sync-promote.test.ts`

- [ ] **Step 1: Escrever os testes (falham — módulo não existe)**

```typescript
// src/lib/tint/__tests__/sync-promote.test.ts
import { describe, it, expect } from "vitest";
import {
  expandirFormula,
  precoFinalSayer,
  validarSnapshotKeys,
  type EmbalagemVendavel,
  type InsumoPrecoBase,
  type InsumoCorante,
} from "../sync-promote";

describe("expandirFormula (regra de 3 da embalagem de formulação → vendáveis)", () => {
  const itens = [
    { id_corante: "AX", ordem: 1, qtd_ml: 12.5 },
    { id_corante: "VM", ordem: 2, qtd_ml: 3.2 },
  ];
  const vendaveis: EmbalagemVendavel[] = [
    { id_embalagem: "EMB-900", volume_ml: 900 },
    { id_embalagem: "EMB-3600", volume_ml: 3600 },
  ];

  it("expande qtds pelo fator vol_destino/vol_formulacao", () => {
    const out = expandirFormula({ volumeFormulacaoMl: 900, itens }, vendaveis);
    expect(out).toHaveLength(2);
    const e900 = out.find((e) => e.id_embalagem === "EMB-900")!;
    const e3600 = out.find((e) => e.id_embalagem === "EMB-3600")!;
    expect(e900.itens[0].qtd_ml).toBe(12.5); // fator 1
    expect(e3600.itens[0].qtd_ml).toBe(50); // 12.5 × 4
    expect(e3600.itens[1].qtd_ml).toBeCloseTo(12.8, 6); // 3.2 × 4
    expect(e3600.volume_final_ml).toBe(3600);
  });

  it("volume de formulação 0 → vazio (guarda divisão por zero)", () => {
    expect(expandirFormula({ volumeFormulacaoMl: 0, itens }, vendaveis)).toEqual([]);
  });

  it("volume de formulação null → vazio", () => {
    expect(expandirFormula({ volumeFormulacaoMl: null, itens }, vendaveis)).toEqual([]);
  });

  it("zero embalagens vendáveis → vazio (não inventa embalagem)", () => {
    expect(expandirFormula({ volumeFormulacaoMl: 900, itens }, [])).toEqual([]);
  });

  it("embalagem vendável com volume inválido é pulada", () => {
    const out = expandirFormula({ volumeFormulacaoMl: 900, itens }, [
      { id_embalagem: "EMB-OK", volume_ml: 900 },
      { id_embalagem: "EMB-RUIM", volume_ml: 0 },
      { id_embalagem: "EMB-NULL", volume_ml: null as unknown as number },
    ]);
    expect(out.map((e) => e.id_embalagem)).toEqual(["EMB-OK"]);
  });
});

describe("precoFinalSayer (pág 9 do manual: base×(1+imp)×(1+marg) + Σ corantes/ml; NULL honesto)", () => {
  const base: InsumoPrecoBase = { custo: 100, imposto_pct: 30, margem_pct: 50 };
  const corantes: InsumoCorante[] = [
    { id_corante: "AX", custo: 200, volume_ml: 900 },
  ];

  it("reproduz o exemplo do manual (100 → 130 → 195) + corante 0,222/ml × 5ml", () => {
    const out = precoFinalSayer(base, [{ id_corante: "AX", qtd_ml: 5 }], corantes);
    // 195 + (200/900)*5 = 195 + 1.1111... → round2 = 196.11
    expect(out).toBe(196.11);
  });

  it("sem corantes = só a base", () => {
    expect(precoFinalSayer(base, [], corantes)).toBe(195);
  });

  it("insumo da base ausente → null (NUNCA 0)", () => {
    expect(precoFinalSayer(null, [{ id_corante: "AX", qtd_ml: 5 }], corantes)).toBeNull();
  });

  it("corante usado sem preço → null (não fabrica preço parcial)", () => {
    const out = precoFinalSayer(base, [{ id_corante: "ZZ", qtd_ml: 5 }], corantes);
    expect(out).toBeNull();
  });

  it("corante com volume 0/null → null (não divide por zero)", () => {
    const out = precoFinalSayer(base, [{ id_corante: "AX", qtd_ml: 5 }], [
      { id_corante: "AX", custo: 200, volume_ml: 0 },
    ]);
    expect(out).toBeNull();
  });

  it("custo base 0 é VÁLIDO (≠ ausente): preço = só corantes", () => {
    const out = precoFinalSayer({ custo: 0, imposto_pct: 30, margem_pct: 50 }, [{ id_corante: "AX", qtd_ml: 9 }], corantes);
    expect(out).toBe(2); // (200/900)*9 = 2.00
  });
});

describe("validarSnapshotKeys (blast radius — chunk perdido não apaga a loja)", () => {
  it("aprova snapshot saudável (pouca deleção)", () => {
    const r = validarSnapshotKeys({ totalOficialAtivas: 1000, chavesNoSnapshot: 990, desativariam: 10 });
    expect(r.ok).toBe(true);
  });
  it("aborta se desativaria >20% das ativas", () => {
    const r = validarSnapshotKeys({ totalOficialAtivas: 1000, chavesNoSnapshot: 700, desativariam: 300 });
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/blast/i);
  });
  it("aborta se snapshot < 50% do oficial ativo (snapshot incompleto)", () => {
    const r = validarSnapshotKeys({ totalOficialAtivas: 1000, chavesNoSnapshot: 400, desativariam: 600 });
    expect(r.ok).toBe(false);
  });
  it("oficial vazio (primeira carga) → ok com snapshot qualquer", () => {
    const r = validarSnapshotKeys({ totalOficialAtivas: 0, chavesNoSnapshot: 100, desativariam: 0 });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `bun run test src/lib/tint/__tests__/sync-promote.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar `sync-promote.ts`**

```typescript
// src/lib/tint/sync-promote.ts
// Oráculo puro da promoção staging→oficial do tint sync.
// ESPELHADO VERBATIM na migration tint_promote_sync_run (PG17 valida o espelho).
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §6.2

export interface FormulaBase {
  volumeFormulacaoMl: number | null;
  itens: Array<{ id_corante: string; ordem: number; qtd_ml: number }>;
}
export interface EmbalagemVendavel { id_embalagem: string; volume_ml: number }
export interface FormulaExpandida {
  id_embalagem: string;
  volume_final_ml: number;
  itens: Array<{ id_corante: string; ordem: number; qtd_ml: number }>;
}
export interface InsumoPrecoBase { custo: number; imposto_pct: number; margem_pct: number }
export interface InsumoCorante { id_corante: string; custo: number; volume_ml: number }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Regra de 3: expande a fórmula (na embalagem de formulação) pra cada embalagem vendável. */
export function expandirFormula(f: FormulaBase, vendaveis: EmbalagemVendavel[]): FormulaExpandida[] {
  if (!f.volumeFormulacaoMl || f.volumeFormulacaoMl <= 0) return [];
  const volForm = f.volumeFormulacaoMl;
  const out: FormulaExpandida[] = [];
  for (const emb of vendaveis) {
    if (!emb.volume_ml || emb.volume_ml <= 0) continue;
    const fator = emb.volume_ml / volForm;
    out.push({
      id_embalagem: emb.id_embalagem,
      volume_final_ml: emb.volume_ml,
      itens: f.itens.map((it) => ({ ...it, qtd_ml: it.qtd_ml * fator })),
    });
  }
  return out;
}

/** Preço pág 9: base×(1+imp)×(1+marg) + Σ(qtd×custo/vol). Insumo faltando → null (nunca 0). */
export function precoFinalSayer(
  base: InsumoPrecoBase | null,
  itensExpandidos: Array<{ id_corante: string; qtd_ml: number }>,
  corantes: InsumoCorante[],
): number | null {
  if (base == null || !Number.isFinite(base.custo)) return null;
  const precoBase = base.custo * (1 + base.imposto_pct / 100) * (1 + base.margem_pct / 100);
  let somaCorantes = 0;
  for (const it of itensExpandidos) {
    const c = corantes.find((x) => x.id_corante === it.id_corante);
    if (!c || !Number.isFinite(c.custo) || !c.volume_ml || c.volume_ml <= 0) return null;
    somaCorantes += (c.custo / c.volume_ml) * it.qtd_ml;
  }
  return round2(precoBase + somaCorantes);
}

/** Guarda de blast radius da desativação por keys-snapshot (§11 P1-B). */
export function validarSnapshotKeys(p: {
  totalOficialAtivas: number;
  chavesNoSnapshot: number;
  desativariam: number;
}): { ok: boolean; motivo?: string } {
  if (p.totalOficialAtivas === 0) return { ok: true }; // primeira carga: nada a desativar
  if (p.chavesNoSnapshot < p.totalOficialAtivas * 0.5) {
    return { ok: false, motivo: "snapshot menor que 50% do oficial ativo (provável chunk perdido)" };
  }
  if (p.desativariam > p.totalOficialAtivas * 0.2) {
    return { ok: false, motivo: "blast radius: desativaria >20% das fórmulas ativas" };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Rodar e ver passar** — `bun run test src/lib/tint/__tests__/sync-promote.test.ts` → PASS (15 testes).
- [ ] **Step 5: Commit** — `git add src/lib/tint && git commit -m "feat(tint): oráculo puro da promoção sync (regra de 3 + preço pág 9 + blast radius)"`

### Task 2: Migration — staging de preços, desativação, snapshot de chaves, promoção

**Files:**
- Create: `supabase/migrations/20260609150000_tint_sync_promote.sql`

> O SQL espelha VERBATIM o helper da Task 1. Conteúdo completo (escrever exatamente; ajustar apenas se o PG17 da Task 3 acusar erro de coluna contra o schema-snapshot):

- [ ] **Step 1: Escrever a migration** com estas seções (todas idempotentes, `IF NOT EXISTS`/`CREATE OR REPLACE`):

```sql
-- 20260609150000_tint_sync_promote.sql
-- Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §6.2/§11
-- A) Staging de preços de base (PRECO_BASEEMB da origem)
CREATE TABLE IF NOT EXISTS public.tint_staging_precos_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id),
  account text NOT NULL,
  store_code text NOT NULL,
  cod_produto text NOT NULL,
  id_base text NOT NULL,
  id_embalagem text NOT NULL,
  custo numeric,
  imposto_pct numeric,
  margem_pct numeric,
  raw_data jsonb,
  staging_status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.tint_staging_precos_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view tint_staging_precos_base" ON public.tint_staging_precos_base
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));
CREATE INDEX IF NOT EXISTS idx_tsp_precos_chave ON public.tint_staging_precos_base (account, cod_produto, id_base, id_embalagem, created_at DESC);

-- B) Custo/volume do corante no staging existente (PRECO_CORANTE chega pelo /catalogs)
ALTER TABLE public.tint_staging_corantes
  ADD COLUMN IF NOT EXISTS custo numeric,
  ADD COLUMN IF NOT EXISTS volume_ml numeric;

-- C) Desativação soft no oficial
ALTER TABLE public.tint_formulas ADD COLUMN IF NOT EXISTS desativada_em timestamptz;
CREATE INDEX IF NOT EXISTS idx_tint_formulas_ativas ON public.tint_formulas (account) WHERE desativada_em IS NULL;

-- D) Snapshot de chaves (chunks montados antes de aplicar — §11 P1-B)
CREATE TABLE IF NOT EXISTS public.tint_keys_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_id uuid NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  snapshot_id uuid NOT NULL,
  entity text NOT NULL,             -- 'formulas' (v1)
  generated_at timestamptz NOT NULL, -- relógio do conector, só p/ ordem
  total_chunks int NOT NULL,
  chunk_index int NOT NULL,
  keys jsonb NOT NULL,               -- array de chaves "cor_id|cod_produto|id_base|id_embalagem|personalizada"
  created_at timestamptz DEFAULT now(),
  UNIQUE (snapshot_id, entity, chunk_index)
);
ALTER TABLE public.tint_keys_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view tint_keys_snapshots" ON public.tint_keys_snapshots
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));
ALTER TABLE public.tint_integration_settings
  ADD COLUMN IF NOT EXISTS last_keys_snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS schema_fingerprint text,
  ADD COLUMN IF NOT EXISTS schema_mismatch jsonb;

-- E) Promoção (latest-staging-por-chave; §6.2). SECURITY DEFINER, search_path fixo.
CREATE OR REPLACE FUNCTION public.tint_promote_sync_run(p_sync_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run record; v_importacao_id uuid;
  v_promovidas int := 0; v_erros int := 0; v_recalc int := 0;
BEGIN
  SELECT * INTO v_run FROM tint_sync_runs WHERE id = p_sync_run_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'run não encontrado'); END IF;

  INSERT INTO tint_importacoes (account, tipo, arquivo_nome, arquivo_hash, status)
  VALUES (v_run.account, 'sync_agent', 'sync:' || p_sync_run_id, p_sync_run_id::text, 'processando')
  RETURNING id INTO v_importacao_id;

  -- E1) Catálogo: upsert oficial a partir do LATEST staging das chaves tocadas pelo run
  --     (produtos, bases, embalagens, corantes [com custo/volume p/ preço], skus de produto_base_embalagem)
  --     Espelha onConflict do tint-import: (account,cod_produto) / (account,id_base_sayersystem) / etc.
  -- E2) Fórmulas: para cada chave de fórmula tocada pelo run (latest staging por
  --     (account,cor_id,cod_produto,id_base,personalizada)):
  --     guarda vol_formulacao<=0 → tint_sync_errors; expansão SÓ por embalagens vendáveis
  --     (tint_skus do par) com fator vol_destino/vol_formulacao (espelho de expandirFormula);
  --     preço por precoFinalSayer (insumo faltando → NULL); upsert por uq_tint_formulas_chave;
  --     itens delete+insert; desativada_em = NULL (reativa).
  -- E3) Skus novos no run → re-expandir fórmulas (latest staging) dos pares afetados.
  -- E4) Run de precos_base/corantes → recalcular preco_final_sayersystem das fórmulas
  --     afetadas (por par e por corante usado em tint_formula_itens) SEM re-expandir (§11 P1-A).
  -- E5) Contadores em tint_importacoes + tint_sync_runs; purge staging >30d; runs órfãos >30min → error.
  -- (corpo completo escrito na execução desta task, espelhando sync-promote.ts função a função;
  --  o PG17 da Task 3 é quem prova a equivalência com o oráculo — não confiar em leitura)

  UPDATE tint_importacoes SET status='concluido', registros_importados=v_promovidas, registros_erro=v_erros
  WHERE id = v_importacao_id;
  RETURN jsonb_build_object('ok', true, 'promovidas', v_promovidas, 'recalculadas', v_recalc, 'erros', v_erros, 'importacao_id', v_importacao_id);
END $$;
REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM anon, authenticated, PUBLIC;

-- F) Aplicação do keys-snapshot com guardas (§11 P1-B; espelho de validarSnapshotKeys)
CREATE OR REPLACE FUNCTION public.tint_apply_keys_snapshot(p_snapshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
-- 1. monta chunks (abort se faltam: count(distinct chunk_index) <> total_chunks);
-- 2. ignora se generated_at <= last_keys_snapshot_at do setting (fora de ordem);
-- 3. blast radius: snapshot < 50% do oficial ativo OU desativaria > 20% → abort + tint_sync_errors;
-- 4. desativada_em = now() nas fórmulas ativas fora do snapshot; reativa não é aqui (promoção reativa);
-- 5. last_keys_snapshot_at = generated_at; retorna contadores.
$$;
REVOKE EXECUTE ON FUNCTION public.tint_apply_keys_snapshot(uuid) FROM anon, authenticated, PUBLIC;
```

(Os corpos E1–E5 e F1–F5 são escritos COMPLETOS nesta task — os comentários acima são o contrato; a Task 3/PG17 é o juiz. Manter cada fórmula idêntica ao helper: `fator = vol_destino/vol_form`, `round(x*100)/100`, thresholds 50%/20%.)

- [ ] **Step 2: Commit** — `git add supabase/migrations && git commit -m "feat(tint): migration da promoção staging→oficial + keys-snapshot + desativação"`

### Task 3: PG17 — oráculo executável da promoção

**Files:**
- Create: `db/test-tint-promote.sh` (base: copiar estrutura de `db/test-minimo-forcado.sh`)

- [ ] **Step 1: Escrever o script** que sobe PG17 descartável (mesma receita dos `db/test-*.sh`: `schema-snapshot.sql` + stubs + a migration nova por cima) e roda os cenários, cada um com `DO $$ ... ASSERT ... $$`:
  1. **Expansão:** staging de 1 fórmula (formulação 900ml, itens 12.5/3.2ml) + skus 900+3600 → promove → oficial tem 2 fórmulas; itens da 3600 = 50/12.8; `volume_final_ml` correto.
  2. **Preço pág 9:** precos_base custo=100 imp=30 marg=50 + corante custo=200 vol=900 + item 5ml → `preco_final_sayersystem = 196.11`; corante sem preço → NULL (nunca 0).
  3. **Recálculo por insumo (P1-A):** muda `custo` no staging de precos_base → novo run só de preço → `preco_final_sayersystem` da fórmula JÁ promovida muda, itens intactos.
  4. **Latest-per-key (P1-C):** staging da MESMA chave em 2 runs (preços diferentes) → promover o run velho DEPOIS do novo → oficial fica com o valor do staging mais RECENTE.
  5. **Re-expansão por sku novo (P1-C):** fórmula promovida com 1 embalagem; chega sku novo do par → promoção do catálogo cria a fórmula da embalagem nova.
  6. **Guardas:** vol_formulacao=0 → não promove + linha em `tint_sync_errors`; zero vendáveis → idem.
  7. **Keys-snapshot:** completo e saudável desativa só o que sumiu; **incompleto (faltando chunk) → aborta**; **blast >20% → aborta**; fórmula desativada que volta no staging → reativa (`desativada_em` NULL).
  8. **Idempotência:** rodar a promoção 2× → estado idêntico (count + sum de preços).
- [ ] **Step 2: Rodar** — `heavy bash db/test-tint-promote.sh > /tmp/tint-pg17.log 2>&1; echo $?` → `0` e log com todos os asserts OK. Iterar a migration até passar.
- [ ] **Step 3: Commit** — `git add db/test-tint-promote.sh && git commit -m "test(tint): PG17 oráculo da promoção (8 cenários)"`

### Task 4: Edge `tint-sync-agent` — bulk, keys-snapshot, fixes, gate de promoção

**Files:**
- Modify: `supabase/functions/tint-sync-agent/index.ts`

- [ ] **Step 1: `validateAgent` retorna `integrationMode`** (linha ~122: incluir `integration_mode` no retorno).
- [ ] **Step 2: Fix replay falso (§3.1.2, linha ~133):** em `checkIdempotency`, se o run achado tem `status='running'` OU `idempotency_response IS NULL` → retornar `json({ ok:false, error:"previous attempt incomplete, retry later", retry:true }, 409)` em vez de sucesso zerado.
- [ ] **Step 3: BULK inserts no staging (full sync ~29k não cabe linha-a-linha no budget da edge):**
  - `/catalogs` (linhas ~276-316): montar `rows[]` por entidade e `insert(rows)` único por entidade (chunks de 500); erros contam por chunk com `logError`.
  - `/formulas` (linhas ~346-397): `insert` bulk das fórmulas com `.select("id")` (ordem preservada) → montar itens com `staging_formula_id` mapeado → `insert` bulk dos itens. **Checar o erro do insert de itens** (fix §3.1.3): falha → `errors++` + `logError` + remover a fórmula do staging do run (`delete` por id) pra não promover fórmula sem itens.
- [ ] **Step 4: `/catalogs` aceita `precos_base[]`** → staging `tint_staging_precos_base` (campos `cod_produto,id_base,id_embalagem,custo,imposto_pct,margem_pct`, bulk como acima; `validateBatchSize` ganha `"precos_base"`).
- [ ] **Step 5: Endpoint `POST /keys-snapshot`:** auth de agente; body `{ entity:"formulas", snapshot_id, generated_at, total_chunks, chunk_index, keys: string[] }`; valida (`keys.length ≤ 50000`, campos presentes); insere em `tint_keys_snapshots` (upsert por `(snapshot_id,entity,chunk_index)` ignorando dup); se `count(chunks recebidos) === total_chunks` E modo `automatic_primary` → `sb.rpc("tint_apply_keys_snapshot", { p_snapshot_id })` e retorna o resultado; senão `{ ok:true, awaiting_chunks }`.
- [ ] **Step 6: Gate de promoção:** ao FIM de `/catalogs` e `/formulas` (antes do `return`), se `agent.integrationMode === "automatic_primary"` → `sb.rpc("tint_promote_sync_run", { p_sync_run_id: runId })`; anexar o resultado na resposta (`promotion: result`); erro da RPC → `completeSyncRun(..., "error")` + repassar no JSON (`ok:false`). Em `shadow_mode` nada muda (staging+reconcile só).
- [ ] **Step 7: Heartbeat persiste `schema_fingerprint`/`schema_mismatch`** (body novo do conector) nas colunas novas do settings.
- [ ] **Step 8: `deno check supabase/functions/tint-sync-agent/index.ts`** — erro-set igual ou menor que o da main (lição §5: erros pré-existentes de typing não bloqueiam).
- [ ] **Step 9: Commit** — `git commit -am "feat(tint): edge sync-agent — bulk staging, keys-snapshot, gate de promoção, fix replay/itens"`

### Task 5: Front — filtro de desativadas + contrato documentado

**Files:**
- Modify: `src/components/tintColorSelect/useTintColorSelect.ts` (query de fórmulas: `.is("desativada_em", null)`)
- Modify: `src/pages/TintFormulas.tsx`, `src/pages/TintCatalogo.tsx`, `src/pages/TintPricing.tsx`, `src/hooks/useGlobalSearch.ts` (busca de fórmulas), `src/hooks/dashboard/useTintometricoZone.ts` (counts) — mesmo filtro
- Modify: `src/pages/TintApiContract.tsx` (documentar `/keys-snapshot`, `precos_base[]`, semântica "id_embalagem = embalagem de FORMULAÇÃO" no `/formulas`)

- [ ] **Step 1:** aplicar `.is("desativada_em", null)` em cada query de `tint_formulas` dos 6 consumidores (em `TintFormulas.tsx`, alternativa melhor: mostrar com badge "desativada" via coluna; decisão do executor — o REQUISITO duro é a busca de venda `useTintColorSelect` + `useGlobalSearch` nunca retornarem desativada).
- [ ] **Step 2:** `bun run typecheck && bun run test` → verdes. (`tint_formulas.desativada_em` ainda não existe no types.ts gerado — usar `.is()` é string-based, não quebra; NÃO editar `types.ts` na mão, lição §10.)
- [ ] **Step 3: Commit** — `git commit -am "feat(tint): app ignora fórmulas desativadas pelo sync + contrato atualizado"`

### Task 6: Gate de CI + PR1

- [ ] **Step 1:** `heavy bun run typecheck > /tmp/tc.log 2>&1; echo $?` → 0 · `heavy bun run test > /tmp/t.log 2>&1; echo $?` → 0 · `bun lint > /tmp/l.log 2>&1; echo $?` → 0 · `heavy bun build > /tmp/b.log 2>&1; echo $?` → 0 (checar os logs, NUNCA pipe pra tail).
- [ ] **Step 2:** `git push -u origin <branch> && gh pr create` — descrição com "**ATENÇÃO: migration manual necessária**" + bloco SQL inline + aviso de deploy da edge. `gh pr merge --squash --auto`.

## PR2 — Conector `sayersync` (Go)

### Task 7: Scaffold + config + serviço Windows

**Files:**
- Create: `connector/sayersync/go.mod` (module `sayersync`; deps: `github.com/jackc/pgx/v5`, `github.com/kardianos/service`, `golang.org/x/sys`)
- Create: `connector/sayersync/main.go` — subcomandos `install|uninstall|run|once|discovery|version`; `install` pergunta interativo (stdin): URL do app (default `https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/tint-sync-agent`), `store_code`, token, conn PG (default `postgres://integra:integra@localhost:5986/client_industrial_sayerlack`); grava `config.json` + registra serviço `SayerSync` (kardianos, `LocalService`, restart on-failure).
- Create: `connector/sayersync/config.go` — load/save `config.json` (ao lado do exe); campos: `app_url, store_code, token_dpapi (base64), pg_conn, intervalo_min (10), version`; token NUNCA em claro (DPAPI machine scope via `golang.org/x/sys/windows` + `CryptProtectData`/`CryptUnprotectData`; build não-Windows usa fallback claro com aviso — só p/ dev).
- Create: `connector/sayersync/state.go` — `state.json`: HWM por entidade (`map[string]string` ISO), `last_keys_snapshot`, `last_full_rescan`.

- [ ] **Step 1:** implementar; `GOOS=windows GOARCH=amd64 go build` compila limpo; `go vet` limpo.
- [ ] **Step 2: Commit.**

### Task 8: Mapeamento + discovery + extração (o coração)

**Files:**
- Create: `connector/sayersync/mapping.go` — tabela esperada → colunas esperadas (dos fatos §2.2 do spec): `produto(id_produto,descricao,data_atualizacao)`, `base(id_base,descricao,data_atualizacao)`, `embalagens(id_emb,descricao,conteudo→volume_ml,data_atualizacao)`, `produto_base_embalagem(id_produto,id_base,id_emb,data_atualizacao)`, `corantes(id_corante,descricao,data_atualizacao)`, `preco_corante(id_corante,custo,volume,data_atualizacao)`, `preco_baseemb(id_produto,id_base,id_emb,custo,imposto,margem,data_atualizacao)`, `padracor(id_padraocor,descricao,data_atualizacao)`, `colecao/subcolecao`, `formula(id_padraocor,id_produto,id_base,id_emb,…corantes,data_atualizacao)`, `personcor/formulaperson` (espelhos personalizada). **Nomes reais podem divergir** → `Validate(conn)` compara com `information_schema.columns` (case-insensitive) e devolve o diff; **mapeadores DUAIS pra FORMULA** (colunas achatadas `corante1..6/qtd1..6` OU tabela filha `formula_item` — `Validate` detecta qual existe).
- Create: `connector/sayersync/discovery.go` — despeja `information_schema` (tabelas+colunas+tipos) de TODAS as tabelas acessíveis em `sayersystem-schema.txt` (UTF-8, legível) + retorna fingerprint = sha256 do dump normalizado.
- Create: `connector/sayersync/pg.go` — `Extract(entity, hwm)` roda `SELECT` com `WHERE data_atualizacao > $1 OR data_atualizacao IS NULL` (param `time.Time` hwm−5min), `client_encoding=UTF8`, conexão curta; devolve linhas + `maxDataAtualizacao` observado (**HWM = relógio da ORIGEM, §11 P1-D**).

- [ ] **Step 1:** implementar com testes unitários Go pros mapeadores (fixtures de linhas → payload do contrato; rodar `go test ./...`).
- [ ] **Step 2: Commit.**

### Task 9: Cliente da API + ciclo de sync

**Files:**
- Create: `connector/sayersync/api.go` — POST com headers `x-sync-token/x-store-code/x-idempotency-key` (uuid v4 por lote), retry 3× backoff exponencial (1/4/16s), timeout 60s; trata 409 (`retry:true`) como retryable; resposta com `error_count>0` loga os `errors[]`.
- Create: `connector/sayersync/sync.go` — orquestra o ciclo (ordem do spec §5.3): catálogo → preços → fórmulas → personalizadas; lotes ≤1000; HWM por entidade avança SÓ após 2xx; `once` = 1 ciclo; loop do serviço = ticker `intervalo_min`; **1×/dia** keys-snapshot (chaves de fórmulas: `cor_id|cod_produto|id_base|id_embalagem|personalizada`, chunks ≤50k, `snapshot_id` uuid + `generated_at` now da ORIGEM via `SELECT now()` no PG local); **domingo** full re-scan (HWM zerado em memória); heartbeat por ciclo (`agent_version, hostname, uptime, db_connected, schema_fingerprint, last_cycle_counts`); schema mismatch → NÃO sinca, heartbeat com `schema_mismatch`, grava txt.

- [ ] **Step 1:** implementar + `go test ./...` (mock do servidor HTTP com `httptest` cobrindo: retry em 5xx, 409 não avança HWM, chunking de keys).
- [ ] **Step 2: Commit.**

### Task 10: Auto-update + build + instalação

**Files:**
- Create: `connector/sayersync/update.go` — 1×/dia GET `<storage>/sayersync/manifest.json` (`{version, sha256, url}`); versão > atual (semver) → baixa pra `.new`, sha256 confere → renomeia atual→`.prev`, `.new`→atual, restart via service; 3 crashes em 10min (marcador em state.json) → restaura `.prev`.
- Create: `connector/sayersync/INSTALACAO.md` — **1 página pt-BR pro founder**: baixar exe → clicar não; abrir `cmd` como administrador → `sayersync.exe install` → colar 3 valores (URL já default; store_code e token copiados da tela `/tintometrico/integracao` → Integrações) → `sayersync.exe once` pra smoke → conferir heartbeat verde na tela. + troubleshooting (firewall, porta 5986, como me mandar `sayersystem-schema.txt` se pedir).
- Create: `connector/sayersync/README.md` — build: `GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -X main.Version=X.Y.Z" -o sayersync.exe` + gerar manifest (`shasum -a 256`).

- [ ] **Step 1:** implementar; compilar `sayersync.exe` final; `go vet` + `go test ./...` verdes.
- [ ] **Step 2:** Commit + push + `gh pr create` (PR2) + auto-merge.
- [ ] **Step 3 (pós-merge, founder):** subir `sayersync.exe` + `manifest.json` no bucket Storage (criar bucket público-RO `sayersync` — instrução pro chat do Lovable no PR) OU, mais simples pra v1: eu envio o exe direto pro founder (Storage fica pro auto-update).

## Amanhã (a parte da máquina — roteiro)

1. Founder cria a loja em `/tintometrico/integracao` → Integrações → token (já dá pra fazer hoje se publicado).
2. Instala o conector (INSTALACAO.md). `sayersync.exe once` → heartbeat verde.
3. Se `schema_mismatch`: founder me manda `sayersystem-schema.txt` → ajusto `mapping.go` → novo exe (1 ida-e-volta prevista no spec).
4. `shadow_mode`: full sync → staging → `TintReconciliation` mostra divergências vs oficial (CSV antigo).
5. Founder exporta o CSV **gabarito** → valido expansão+preço (reconciliação + os números do CSV que o próprio SayerSystem calculou).
6. Bateu → `automatic_primary`. Teste final do critério de pronto: founder muda 1 preço no SayerSystem → app reflete em ≤15 min.

## Self-review do plano (feito)
- Cobertura do spec: §6.1 (Task 4), §6.2 (Tasks 1-3), §6.3 (Task 5), §5 (Tasks 7-9), auto-update §5 (Task 10), validação §8 (roteiro). Os 4 P1 da §11: P1-A → Task 2-E4 + PG17 cenário 3; P1-B → Tasks 1/2-F/3.7; P1-C → Task 2 princípio + PG17 4/5; P1-D → Tasks 8/9 (HWM).
- Sem placeholders ocultos: o corpo plpgsql é declarado como "escrever na execução com o PG17 como juiz" — decisão explícita, não omissão (o SQL final depende do snapshot; o contrato e as fórmulas estão fixados aqui e no helper).
- Tipos consistentes entre Task 1 (helper) ↔ Task 2 (SQL) ↔ Task 3 (asserts): fator/round2/thresholds idênticos.
