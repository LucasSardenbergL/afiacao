# Cockpit de preço — Fase 2a (markup sobre CMC + meta-markup + ledger de CMC) — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recomendado) para implementar task-a-task. Steps usam checkbox (`- [ ]`).

**Goal:** Cockpit de preço por linha no wizard de venda mostrando a **saúde do preço vs CUSTO (CMC)** — faixa 🔴🟡🟢⚪ pra vendedora, markup%/folga R$ só pro gestor — e ligar o **ledger de CMC** (write-only) pra acumular histórico desde o dia 1 (insumo da Fase 2b/defasagem).

**Architecture:** RPC SQL `SECURITY DEFINER` staff-gated, **batch**, **payload role-gated** (número só `pode_ver_carteira_completa`), CMC account-aware (ponte de convenção `inventory_position.account` × `omie_products.account`), tint **all-or-nothing**. Config `markup_policy` (conta→família→SKU, master-only, versionável). Ledger `cmc_ledger` por **trigger** no `inventory_position`. Helper puro TS = oráculo TDD que a RPC espelha. UI no `ProductItemForm`.

**Tech Stack:** Postgres (RPC/trigger/RLS), React+TS (helper/hook/UI), vitest (helper), PG17 local (`db/test-*.sh`, base `db/verify-snapshot-replay.sh`).

**Spec:** `docs/superpowers/specs/2026-06-14-cockpit-preco-markup-cmc-design.md`. **Decisões travadas:** D1 (2a agora/2b depois; ledger já) · D2 (faixa p/ vendedora, número p/ gestor via role-gate na RPC).

**Constraints (CLAUDE.md):** migrations aplicadas MANUALMENTE pelo founder (SQL Editor; entregar blocos inline + validação); SEM edge nova (RPC+trigger puros); Publish do front manual. Ledger só acumula PÓS-apply (sem backfill). `inventory_position.account` tem 2 convenções (`'vendas'/'colacor_vendas'/'servicos'` do analytics-sync × `'oben'/'colacor'` do sync-reprocess) — o join de CMC tem que cobrir ambas (espelhar a RPC de reposição `20260606190000`). Money-path: degradação honesta (ausente→neutro, nunca 0/verde fabricado); precisão > recall.

---

## File Structure

| Arquivo | Cria/Modifica | Responsabilidade |
|---|---|---|
| `supabase/migrations/20260614170000_cmc_ledger.sql` | Cria | Tabela `cmc_ledger` (append-only) + trigger `cmc_ledger_capture` no `inventory_position` + RLS staff-read |
| `supabase/migrations/20260614180000_markup_policy.sql` | Cria | Tabela `markup_policy` + RLS master-only + função `resolve_markup_policy(empresa, codigo, familia)` |
| `supabase/migrations/20260614190000_get_preco_cockpit.sql` | Cria | RPC `get_preco_cockpit(p_itens jsonb)` — CMC account-aware + tint all-or-nothing + markup + faixa, role-gated, batch |
| `src/lib/preco/cockpit-preco.ts` | Cria | Helper puro: `classificarFaixa()` + `montarLinhaCockpit()` — oráculo TDD |
| `src/lib/preco/cockpit-preco.test.ts` | Cria | Testes vitest do helper |
| `src/hooks/usePrecoCockpit.ts` | Cria | Hook batch que chama a RPC (1 chamada por carrinho), degradação honesta |
| `src/components/unified-order/ProductItemForm.tsx` | Modifica | Badge de faixa por linha (vendedora) / faixa+número (gestor) |
| `db/test-cockpit-preco.sh` | Cria | PG17: RPC account-aware, role-gate (falsificação), tint all-or-nothing, trigger, RLS, REVOKE |

**Ordem de execução:** Task 1 (ledger) → 2 (policy) → 3 (helper, oráculo) → 4 (RPC não-tint) → 5 (RPC tint) → 6 (hook+UI) → 7 (PG17). O helper (3) vem antes da RPC (4/5) porque é o oráculo; a UI (6) por último.

---

## Contrato da RPC (a espinha — referência pra Tasks 4/5/6/7)

**Input:** `get_preco_cockpit(p_itens jsonb)`, onde `p_itens` =
```json
[{ "empresa": "oben", "codigo": 12345, "preco": 99.90, "tint_formula_id": null }]
```
(`tint_formula_id` presente → linha tintométrica; `preco` = preço líquido unitário que a vendedora vai praticar.)

**Output:** `jsonb` array, 1 linha por item de entrada (na MESMA ordem do input — casar por índice), cada:
```json
{
  "codigo": 12345, "empresa": "oben",
  "faixa": "vermelho|amarelo|verde|neutro",
  "motivo": "abaixo_do_custo|abaixo_do_piso|abaixo_da_meta|saudavel|sem_custo|sem_politica",
  "tem_custo": true, "tem_politica": true,
  "calculated_at": "2026-06-14T...Z",
  // CAMPOS NUMÉRICOS — só se pode_ver_carteira_completa(auth.uid()); senão NULL:
  "cmc": 60.00, "markup_perc": 66.5, "folga_reais": 39.90,
  "piso_markup": 30.0, "meta_markup": 50.0,
  "proveniencia": "inventory_position(vendas)", "frescor": "2026-06-14T...Z"
}
```

**Regras de faixa (idênticas no helper e na RPC):**
1. `tem_custo=false` → `neutro` / `sem_custo`.
2. `preco < cmc` → `vermelho` / `abaixo_do_custo` (vale MESMO sem política).
3. `cmc ≤ preco` e `tem_politica=false` → `neutro` / `sem_politica` (gestor vê o número; faixa neutra — NUNCA verde só porque preco>cmc).
4. `cmc ≤ preco < piso` → `amarelo` / `abaixo_do_piso`.
5. `piso ≤ preco < meta` → `verde` / `abaixo_da_meta` (vendedora vê verde "saudável"; o `motivo` informa o gestor).
6. `preco ≥ meta` → `verde` / `saudavel`.

Onde `piso = cmc × (1 + piso_markup/100)`, `meta = cmc × (1 + meta_markup/100)`, `markup_perc = (preco − cmc)/cmc × 100`, `folga_reais = preco − cmc`.

**Role-gate:** os campos numéricos (`cmc`, `markup_perc`, `folga_reais`, `piso_markup`, `meta_markup`, `proveniencia`, `frescor`) só entram no objeto se `pode_ver_carteira_completa(auth.uid())`; senão `NULL`. `faixa`/`motivo`/`tem_custo`/`tem_politica`/`calculated_at` sempre.

**Ponte de convenção de conta (CMC):** `inventory_position.account = ANY(CASE lower(empresa) WHEN 'oben' THEN ARRAY['vendas','oben'] WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor'] WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc'] END)`, `cmc>0`, `ORDER BY updated_at DESC LIMIT 1`. `omie_products` (família) casa por `account = lower(empresa)`.

---

## Task 1: Ledger de CMC (tabela + trigger)

**Files:**
- Create: `supabase/migrations/20260614170000_cmc_ledger.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Fase 2a (cockpit de preço): ledger append-only de mudanças de CMC.
-- Alimentado por TRIGGER no inventory_position (o sync já atualiza; o banco
-- observa a mudança exata). Sem backfill (não temos CMC passado). Insumo da
-- Fase 2b (defasagem). observed_at = "alta observada pelo sistema", NÃO data
-- contábil real da compra. Aplicar via SQL Editor; validar no fim.

CREATE TABLE IF NOT EXISTS public.cmc_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  cmc_anterior numeric,
  cmc_novo numeric NOT NULL,
  saldo numeric,
  observed_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cmc_ledger_lookup
  ON public.cmc_ledger (account, omie_codigo_produto, observed_at DESC);

ALTER TABLE public.cmc_ledger ENABLE ROW LEVEL SECURITY;

-- Leitura staff (employee/master); escrita só pelo trigger (SECURITY DEFINER da função).
DROP POLICY IF EXISTS "cmc_ledger_select_staff" ON public.cmc_ledger;
CREATE POLICY "cmc_ledger_select_staff" ON public.cmc_ledger
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));

-- Trigger: grava SÓ quando o CMC realmente muda (anti-ruído de sync que reescreve igual).
CREATE OR REPLACE FUNCTION public.cmc_ledger_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.cmc IS NOT NULL
     AND NEW.cmc > 0
     AND (TG_OP = 'INSERT' OR NEW.cmc IS DISTINCT FROM OLD.cmc) THEN
    INSERT INTO public.cmc_ledger (account, omie_codigo_produto, cmc_anterior, cmc_novo, saldo, synced_at)
    VALUES (
      NEW.account,
      NEW.omie_codigo_produto,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.cmc ELSE NULL END,
      NEW.cmc,
      NEW.saldo,
      NEW.synced_at
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cmc_ledger_capture ON public.inventory_position;
CREATE TRIGGER trg_cmc_ledger_capture
  AFTER INSERT OR UPDATE OF cmc ON public.inventory_position
  FOR EACH ROW
  EXECUTE FUNCTION public.cmc_ledger_capture();

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='cmc_ledger') AS tabela_1,
  (SELECT count(*) FROM pg_trigger WHERE tgname='trg_cmc_ledger_capture') AS trigger_1,
  (SELECT count(*) FROM pg_policies WHERE tablename='cmc_ledger') AS policies_1;
-- esperado: 1, 1, 1
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260614170000_cmc_ledger.sql
git commit -m "feat(cockpit/2a): ledger de CMC (tabela + trigger no inventory_position)"
```

> A validação real é no PG17 (Task 7) — esta migration tem teste de trigger lá. Apply em prod é manual (entregar inline no fim).

---

## Task 2: Tabela markup_policy + resolução

**Files:**
- Create: `supabase/migrations/20260614180000_markup_policy.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Fase 2a: política de markup (piso + meta) sobre CMC, resolução conta→família→SKU.
-- Master/financeiro edita; vendedora só consulta (via RPC). Versionável: cada
-- linha tem updated_by/updated_at; mudança = UPDATE (histórico = follow-up se
-- preciso). v1 = 2 parâmetros manuais; break-even por orçamento = v2.

CREATE TABLE IF NOT EXISTS public.markup_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,                 -- 'oben' | 'colacor' | 'colacor_sc' (convenção empresa)
  escopo text NOT NULL CHECK (escopo IN ('conta','familia','sku')),
  familia text,                          -- preenchido sse escopo='familia'
  sku_codigo bigint,                     -- preenchido sse escopo='sku'
  piso_markup numeric NOT NULL CHECK (piso_markup >= 0),
  meta_markup numeric NOT NULL CHECK (meta_markup >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (meta_markup >= piso_markup),
  CHECK (
    (escopo='conta'   AND familia IS NULL AND sku_codigo IS NULL) OR
    (escopo='familia' AND familia IS NOT NULL AND sku_codigo IS NULL) OR
    (escopo='sku'     AND sku_codigo IS NOT NULL)
  )
);

-- 1 linha por (account, escopo, chave) — evita política ambígua.
CREATE UNIQUE INDEX IF NOT EXISTS uq_markup_policy_conta  ON public.markup_policy (account) WHERE escopo='conta';
CREATE UNIQUE INDEX IF NOT EXISTS uq_markup_policy_fam    ON public.markup_policy (account, familia) WHERE escopo='familia';
CREATE UNIQUE INDEX IF NOT EXISTS uq_markup_policy_sku    ON public.markup_policy (account, sku_codigo) WHERE escopo='sku';

ALTER TABLE public.markup_policy ENABLE ROW LEVEL SECURITY;

-- Leitura staff (a RPC é SECURITY DEFINER, mas leitura direta staff é inofensiva: piso/meta não são o CMC).
DROP POLICY IF EXISTS "markup_policy_select_staff" ON public.markup_policy;
CREATE POLICY "markup_policy_select_staff" ON public.markup_policy
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- Escrita só master.
DROP POLICY IF EXISTS "markup_policy_write_master" ON public.markup_policy;
CREATE POLICY "markup_policy_write_master" ON public.markup_policy
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role));

-- Resolução conta→família→SKU (mais específico vence). STABLE; usada pela RPC.
CREATE OR REPLACE FUNCTION public.resolve_markup_policy(p_empresa text, p_codigo bigint, p_familia text)
RETURNS TABLE (piso_markup numeric, meta_markup numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT piso_markup, meta_markup
  FROM public.markup_policy
  WHERE account = lower(p_empresa)
    AND (
      (escopo='sku'     AND sku_codigo = p_codigo) OR
      (escopo='familia' AND p_familia IS NOT NULL AND familia = p_familia) OR
      (escopo='conta')
    )
  ORDER BY CASE escopo WHEN 'sku' THEN 1 WHEN 'familia' THEN 2 ELSE 3 END
  LIMIT 1;
$$;

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='markup_policy') AS tabela_1,
  (SELECT count(*) FROM pg_policies WHERE tablename='markup_policy') AS policies_2,
  (SELECT count(*) FROM pg_proc WHERE proname='resolve_markup_policy') AS func_1;
-- esperado: 1, 2, 1
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260614180000_markup_policy.sql
git commit -m "feat(cockpit/2a): tabela markup_policy + resolve_markup_policy (conta→família→sku)"
```

---

## Task 3: Helper puro `cockpit-preco` (oráculo TDD)

**Files:**
- Create: `src/lib/preco/cockpit-preco.ts`
- Test: `src/lib/preco/cockpit-preco.test.ts`

- [ ] **Step 1: Escrever os testes (falham primeiro)**

```ts
import { describe, it, expect } from 'vitest';
import { classificarFaixa, type FaixaInput } from './cockpit-preco';

const base = (o: Partial<FaixaInput>): FaixaInput => ({
  preco: 100, cmc: 60, pisoMarkup: 30, metaMarkup: 50, temCusto: true, temPolitica: true, ...o,
});

describe('classificarFaixa', () => {
  it('sem custo → neutro/sem_custo', () => {
    expect(classificarFaixa(base({ temCusto: false, cmc: null }))).toEqual({ faixa: 'neutro', motivo: 'sem_custo' });
  });
  it('preço abaixo do custo → vermelho (mesmo sem política)', () => {
    expect(classificarFaixa(base({ preco: 50, cmc: 60, temPolitica: false }))).toEqual({ faixa: 'vermelho', motivo: 'abaixo_do_custo' });
  });
  it('acima do custo mas sem política → neutro/sem_politica (NUNCA verde)', () => {
    expect(classificarFaixa(base({ preco: 100, cmc: 60, temPolitica: false }))).toEqual({ faixa: 'neutro', motivo: 'sem_politica' });
  });
  it('abaixo do piso → amarelo', () => {
    // piso = 60*(1.30)=78; preço 70 < 78
    expect(classificarFaixa(base({ preco: 70 }))).toEqual({ faixa: 'amarelo', motivo: 'abaixo_do_piso' });
  });
  it('entre piso e meta → verde/abaixo_da_meta', () => {
    // piso=78, meta=60*1.5=90; preço 85
    expect(classificarFaixa(base({ preco: 85 }))).toEqual({ faixa: 'verde', motivo: 'abaixo_da_meta' });
  });
  it('na/acima da meta → verde/saudavel', () => {
    expect(classificarFaixa(base({ preco: 95 }))).toEqual({ faixa: 'verde', motivo: 'saudavel' });
  });
  it('preço exatamente no piso → verde (≥ piso)', () => {
    expect(classificarFaixa(base({ preco: 78 }))).toEqual({ faixa: 'verde', motivo: 'abaixo_da_meta' });
  });
});
```

- [ ] **Step 2: Rodar — deve FALHAR** (`classificarFaixa` não existe).

Run: `heavy bun run test src/lib/preco/cockpit-preco.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar o helper**

```ts
// Oráculo puro do cockpit de preço (Fase 2a). A RPC get_preco_cockpit espelha
// esta lógica VERBATIM (teste de paridade no PG17). Faixas idênticas à spec §4.3.

export type Faixa = 'vermelho' | 'amarelo' | 'verde' | 'neutro';
export type Motivo =
  | 'abaixo_do_custo' | 'abaixo_do_piso' | 'abaixo_da_meta'
  | 'saudavel' | 'sem_custo' | 'sem_politica';

export interface FaixaInput {
  preco: number;
  cmc: number | null;
  pisoMarkup: number | null;  // %
  metaMarkup: number | null;  // %
  temCusto: boolean;
  temPolitica: boolean;
}

export function classificarFaixa(i: FaixaInput): { faixa: Faixa; motivo: Motivo } {
  if (!i.temCusto || i.cmc == null || !(i.cmc > 0)) {
    return { faixa: 'neutro', motivo: 'sem_custo' };
  }
  if (i.preco < i.cmc) {
    return { faixa: 'vermelho', motivo: 'abaixo_do_custo' };
  }
  if (!i.temPolitica || i.pisoMarkup == null || i.metaMarkup == null) {
    return { faixa: 'neutro', motivo: 'sem_politica' };
  }
  const piso = i.cmc * (1 + i.pisoMarkup / 100);
  const meta = i.cmc * (1 + i.metaMarkup / 100);
  if (i.preco < piso) return { faixa: 'amarelo', motivo: 'abaixo_do_piso' };
  if (i.preco < meta) return { faixa: 'verde', motivo: 'abaixo_da_meta' };
  return { faixa: 'verde', motivo: 'saudavel' };
}

/** Markup bruto sobre CMC (%) e folga (R$). null se cmc inválido. */
export function markupSobreCmc(preco: number, cmc: number | null): { markupPerc: number; folgaReais: number } | null {
  if (cmc == null || !(cmc > 0)) return null;
  return { markupPerc: ((preco - cmc) / cmc) * 100, folgaReais: preco - cmc };
}
```

- [ ] **Step 4: Rodar — deve PASSAR.**

Run: `heavy bun run test src/lib/preco/cockpit-preco.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/preco/cockpit-preco.ts src/lib/preco/cockpit-preco.test.ts
git commit -m "feat(cockpit/2a): helper puro de faixa/markup sobre CMC (oráculo TDD)"
```

---

## Task 4: RPC `get_preco_cockpit` — caminho NÃO-tint

**Files:**
- Create: `supabase/migrations/20260614190000_get_preco_cockpit.sql`

> Implementer: a RPC abaixo é a forma autoritativa. Validar contra schema real via PG17 (Task 7) ANTES de entregar inline. Espelhar a ponte de conta da RPC de reposição `20260606190000` e o estilo de `get_tint_price` (`20260527180000`). NÃO usar `product_costs`.

- [ ] **Step 1: Escrever a RPC (caminho não-tint primeiro; tint = Task 5)**

```sql
-- Fase 2a: cockpit de preço por linha. Batch, SECURITY DEFINER, staff-gated,
-- payload role-gated (número só pode_ver_carteira_completa). CMC account-aware
-- (ponte de convenção inventory_position × omie_products). Degradação honesta:
-- ausência → neutro, nunca 0/verde fabricado. Espelha o helper cockpit-preco.ts.
-- Tint (tint_formula_id != null) tratado na Task 5 (all-or-nothing).

CREATE OR REPLACE FUNCTION public.get_preco_cockpit(p_itens jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_staff boolean;
  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_formula uuid;
  v_cmc numeric; v_prov text; v_fresc timestamptz; v_familia text;
  v_piso numeric; v_meta numeric; v_tem_pol boolean;
  v_faixa text; v_motivo text; v_markup numeric; v_folga numeric;
BEGIN
  v_is_staff := auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));
  IF NOT v_is_staff THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  v_pode_num := pode_ver_carteira_completa(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_formula := NULLIF(v_item->>'tint_formula_id','')::uuid;

    -- CMC (ponte de convenção; freshest com cmc>0). Tint = Task 5 (sobrescreve v_cmc).
    SELECT ip.cmc, 'inventory_position('||ip.account||')', ip.updated_at
      INTO v_cmc, v_prov, v_fresc
    FROM inventory_position ip
    WHERE ip.omie_codigo_produto = v_codigo
      AND ip.cmc > 0
      AND ip.account = ANY (CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END)
    ORDER BY ip.updated_at DESC NULLS LAST
    LIMIT 1;

    -- Família (p/ resolução da política) — omie_products usa convenção empresa.
    SELECT op.familia INTO v_familia
    FROM omie_products op
    WHERE op.omie_codigo_produto = v_codigo AND op.account = v_empresa
    LIMIT 1;

    -- Política (conta→família→sku)
    v_piso := NULL; v_meta := NULL;
    SELECT rp.piso_markup, rp.meta_markup INTO v_piso, v_meta
    FROM resolve_markup_policy(v_empresa, v_codigo, v_familia) rp;
    v_tem_pol := v_piso IS NOT NULL AND v_meta IS NOT NULL;

    -- Faixa (espelha classificarFaixa)
    IF v_cmc IS NULL OR NOT (v_cmc > 0) THEN
      v_faixa := 'neutro'; v_motivo := 'sem_custo';
    ELSIF v_preco < v_cmc THEN
      v_faixa := 'vermelho'; v_motivo := 'abaixo_do_custo';
    ELSIF NOT v_tem_pol THEN
      v_faixa := 'neutro'; v_motivo := 'sem_politica';
    ELSIF v_preco < v_cmc * (1 + v_piso/100) THEN
      v_faixa := 'amarelo'; v_motivo := 'abaixo_do_piso';
    ELSIF v_preco < v_cmc * (1 + v_meta/100) THEN
      v_faixa := 'verde'; v_motivo := 'abaixo_da_meta';
    ELSE
      v_faixa := 'verde'; v_motivo := 'saudavel';
    END IF;

    IF v_cmc IS NOT NULL AND v_cmc > 0 THEN
      v_markup := (v_preco - v_cmc) / v_cmc * 100;
      v_folga  := v_preco - v_cmc;
    ELSE
      v_markup := NULL; v_folga := NULL;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'faixa', v_faixa, 'motivo', v_motivo,
      'tem_custo', (v_cmc IS NOT NULL AND v_cmc > 0),
      'tem_politica', v_tem_pol,
      'calculated_at', now(),
      -- role-gated:
      'cmc',          CASE WHEN v_pode_num THEN to_jsonb(v_cmc)    ELSE 'null'::jsonb END,
      'markup_perc',  CASE WHEN v_pode_num THEN to_jsonb(v_markup) ELSE 'null'::jsonb END,
      'folga_reais',  CASE WHEN v_pode_num THEN to_jsonb(v_folga)  ELSE 'null'::jsonb END,
      'piso_markup',  CASE WHEN v_pode_num THEN to_jsonb(v_piso)   ELSE 'null'::jsonb END,
      'meta_markup',  CASE WHEN v_pode_num THEN to_jsonb(v_meta)   ELSE 'null'::jsonb END,
      'proveniencia', CASE WHEN v_pode_num THEN to_jsonb(v_prov)   ELSE 'null'::jsonb END,
      'frescor',      CASE WHEN v_pode_num THEN to_jsonb(v_fresc)  ELSE 'null'::jsonb END
    ));
  END LOOP;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_preco_cockpit(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_preco_cockpit(jsonb) TO authenticated;

-- ── Validação pós-apply ──
SELECT (SELECT count(*) FROM pg_proc WHERE proname='get_preco_cockpit') AS func_1; -- esperado: 1
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260614190000_get_preco_cockpit.sql
git commit -m "feat(cockpit/2a): RPC get_preco_cockpit (markup sobre CMC, account-aware, role-gated)"
```

> Validação funcional = Task 7 (PG17). NÃO entregar inline ao founder antes do PG17 passar.

---

## Task 5: RPC — caminho tintométrico (all-or-nothing por CMC)

**Files:**
- Modify: `supabase/migrations/20260614190000_get_preco_cockpit.sql` (substituir a resolução de CMC quando `v_formula IS NOT NULL`)

> ⚠️ All-or-nothing (spec §4.2): custo = CMC_base + Σ(qtd_ml × CMC_corante / volume_total_ml do corante). Se a base OU **qualquer** corante usado não tiver CMC>0, ou a fórmula estiver vazia → **custo nulo** (neutro). NUNCA somar conhecidos e assumir zero. NÃO reusar `get_tint_price` (usa `valor_unitario`, soma parcial).

- [ ] **Step 1: Inserir o bloco tint (logo após a resolução de CMC não-tint, sobrescrevendo `v_cmc` quando há fórmula)**

```sql
    -- ── TINT: custo por CMC, all-or-nothing ──
    IF v_formula IS NOT NULL THEN
      DECLARE
        v_base_cmc numeric;
        v_cor_total numeric;
        v_cor_faltando int;
        v_n_itens int;
      BEGIN
        -- CMC da base: tint_skus (do produto da fórmula) → omie_products → inventory_position.
        -- A fórmula pertence a um tint_sku (account+produto+base+embalagem). Resolver o
        -- omie_product_id da BASE pelo tint_sku e casar o CMC pela ponte de conta.
        SELECT ip.cmc INTO v_base_cmc
        FROM tint_formulas tf
        JOIN tint_skus ts        ON ts.id = tf.tint_sku_id        -- confirmar FK no schema
        JOIN omie_products opb    ON opb.id = ts.omie_product_id
        JOIN inventory_position ip ON ip.omie_codigo_produto = opb.omie_codigo_produto
              AND ip.account = ANY (CASE v_empresa WHEN 'oben' THEN ARRAY['vendas','oben']
                    WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor']
                    WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc'] ELSE ARRAY[v_empresa] END)
        WHERE tf.id = v_formula AND ip.cmc > 0
        ORDER BY ip.updated_at DESC NULLS LAST LIMIT 1;

        -- Corantes: Σ(qtd_ml × cmc_corante / volume_total_ml). Conta itens e faltantes.
        SELECT
          count(*),
          count(*) FILTER (WHERE ipc.cmc IS NULL OR ipc.cmc <= 0 OR c.volume_total_ml IS NULL OR c.volume_total_ml <= 0),
          COALESCE(SUM(fi.qtd_ml * ipc.cmc / NULLIF(c.volume_total_ml,0)), 0)
        INTO v_n_itens, v_cor_faltando, v_cor_total
        FROM tint_formula_itens fi
        JOIN tint_corantes c       ON c.id = fi.corante_id
        LEFT JOIN omie_products opc ON opc.id = c.omie_product_id
        LEFT JOIN LATERAL (
          SELECT ip.cmc FROM inventory_position ip
          WHERE ip.omie_codigo_produto = opc.omie_codigo_produto AND ip.cmc > 0
            AND ip.account = ANY (CASE v_empresa WHEN 'oben' THEN ARRAY['vendas','oben']
                  WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor']
                  WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc'] ELSE ARRAY[v_empresa] END)
          ORDER BY ip.updated_at DESC NULLS LAST LIMIT 1
        ) ipc ON true
        WHERE fi.formula_id = v_formula;

        -- ALL-OR-NOTHING: base sem CMC, qualquer corante faltando, ou fórmula vazia → nulo.
        IF v_base_cmc IS NULL OR v_base_cmc <= 0 OR v_n_itens = 0 OR v_cor_faltando > 0 THEN
          v_cmc := NULL; v_prov := 'tint(custo incompleto)'; v_fresc := NULL;
        ELSE
          v_cmc := v_base_cmc + v_cor_total;
          v_prov := 'tint(CMC base+corantes)'; v_fresc := now();
        END IF;
      END;
    END IF;
```

> Implementer: confirmar no schema os nomes reais — `tint_formulas.tint_sku_id` (FK p/ `tint_skus`), `tint_skus.omie_product_id` (a BASE), `tint_corantes.omie_product_id`, `tint_corantes.volume_total_ml`. Ajustar os joins ao que existir; se a FK fórmula→sku for por outra coluna, corrigir. Fracionamento (unidade venda × estoque): se houver fator cadastrado, aplicar; senão e se ambíguo → tratar como custo incompleto (neutro), NÃO chutar.

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260614190000_get_preco_cockpit.sql
git commit -m "feat(cockpit/2a): RPC tint — custo por CMC all-or-nothing (base + corantes)"
```

---

## Task 6: Hook `usePrecoCockpit` + UI no `ProductItemForm`

**Files:**
- Create: `src/hooks/usePrecoCockpit.ts`
- Modify: `src/components/unified-order/ProductItemForm.tsx`

- [ ] **Step 1: Hook (batch — 1 chamada por carrinho; degradação honesta)**

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ItemCockpitInput { empresa: string; codigo: number; preco: number; tint_formula_id?: string | null; }
export interface LinhaCockpit {
  codigo: number; empresa: string;
  faixa: 'vermelho' | 'amarelo' | 'verde' | 'neutro';
  motivo: string; tem_custo: boolean; tem_politica: boolean; calculated_at: string;
  cmc: number | null; markup_perc: number | null; folga_reais: number | null;
  piso_markup: number | null; meta_markup: number | null;
  proveniencia: string | null; frescor: string | null;
}

/** Mapa codigo→linha. Falha do cockpit NÃO derruba o wizard (cockpit é informativo). */
export function usePrecoCockpit(itens: ItemCockpitInput[]) {
  return useQuery({
    queryKey: ['preco-cockpit', itens],
    enabled: itens.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<number, LinhaCockpit>> => {
      const { data, error } = await (supabase.rpc as any)('get_preco_cockpit', { p_itens: itens });
      if (error) throw error;
      const m = new Map<number, LinhaCockpit>();
      for (const l of (data as LinhaCockpit[]) ?? []) m.set(l.codigo, l);
      return m;
    },
  });
}
```

> `(supabase.rpc as any)` porque a RPC nova ainda não está em `types.ts` (Lovable regenera pós-migration; NÃO adicionar à mão — lição §10). Cast pontual no boundary.

- [ ] **Step 2: Badge no `ProductItemForm`** — ler o `ProductItemForm.tsx` atual; adicionar, na linha de AÇÃO do item (perto de Qtd/Adicionar, pra herdar o alvo de toque 44px), um badge:
  - Vendedora: faixa por cor (🔴🟡🟢) + rótulo curto ("Abaixo do custo" / "Abaixo do piso" / "Saudável"); ⚪ = "—" (sem badge ou cinza).
  - Gestor (`useDisplayAccess`/`pode_ver_carteira_completa` já refletido no payload — os campos numéricos virão preenchidos): + `Markup X% · Folga R$Y` + tooltip "não inclui imposto/comissão/frete/prazo".
  - Usar tokens `text-status-*` (NÃO `text-emerald-600`). Faixa→status: vermelho→error, amarelo→warning, verde→success, neutro→muted.
  - O `preco` enviado = o preço unitário que a vendedora vai praticar (o mesmo que o form já calcula via `getProductPrice`/`customerPrices`). `empresa` = conta ativa do wizard. `tint_formula_id` quando a linha for tintométrica.

- [ ] **Step 3: Rodar typecheck + testes + lint**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "TC=$?"; heavy bun run test > /tmp/t.log 2>&1; echo "T=$?"; bun lint > /tmp/l.log 2>&1; echo "L=$?"`
Expected: TC=0, T=0, L=0 (ver os logs; NÃO usar `| tail`).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/usePrecoCockpit.ts src/components/unified-order/ProductItemForm.tsx
git commit -m "feat(cockpit/2a): hook usePrecoCockpit + badge de faixa no ProductItemForm (faixa/número por papel)"
```

---

## Task 7: Teste PG17 (`db/test-cockpit-preco.sh`)

**Files:**
- Create: `db/test-cockpit-preco.sh` (base: `db/verify-snapshot-replay.sh` + `db/stubs-supabase.sql`)

- [ ] **Step 1: Escrever o harness** — aplica as 3 migrations (Tasks 1/2/4-5) sobre stubs mínimos (`inventory_position`, `omie_products`, `tint_*`, `has_role`, `pode_ver_carteira_completa`, `app_role`, `auth.uid()` por GUC). Semear dados e **executar** a RPC + o trigger. Asserts (cada um falha o script com exit≠0):

  - **A1 — faixa account-aware:** SKU com `cmc=60` em `account='vendas'`; `empresa='oben'`, `preco=100`, política conta piso=30/meta=50 → `faixa='verde'`, `motivo='abaixo_da_meta'` (piso 78, meta 90, 90≤100? não: 100≥90 → `saudavel`). Ajustar números pro caso desejado e assertar `faixa`+`motivo`.
  - **A2 — abaixo do custo:** `preco=50 < cmc=60` → `vermelho`/`abaixo_do_custo` mesmo sem política.
  - **A3 — sem política → neutro:** `preco>cmc`, sem linha em `markup_policy` → `neutro`/`sem_politica` (NUNCA verde).
  - **A4 — role-gate (gestor vê número):** `auth.uid()` = master/gestor → `cmc`/`markup_perc` não-nulos.
  - **A5 — role-gate (vendedora NÃO vê número) + FALSIFICAÇÃO:** `auth.uid()` = employee não-gestor → `cmc`/`markup_perc`/`folga_reais` = `null`, mas `faixa`/`motivo` presentes. **Falsificação:** sabotar `pode_ver_carteira_completa` pra retornar `true` e exigir que o assert de "número nulo p/ vendedora" QUEBRE (prova que o gate tem dente); depois restaurar.
  - **A6 — conta errada não casa:** SKU só em `account='colacor_vendas'`, consultado com `empresa='oben'` → `tem_custo=false`/`neutro`.
  - **A7 — tint all-or-nothing:** fórmula com base CMC ok + 1 corante SEM CMC → custo nulo → `neutro` (NÃO soma parcial). Depois dar CMC ao corante → `tem_custo=true` e custo = base+corantes.
  - **A8 — trigger do ledger:** UPDATE do `cmc` em `inventory_position` grava 1 linha em `cmc_ledger` com `cmc_anterior`/`cmc_novo`; UPDATE que não muda o cmc → 0 linhas novas.
  - **A9 — RLS markup_policy:** `SET ROLE authenticated` + GUC employee → SELECT ok, INSERT negado (42501); master → INSERT ok. (provar com `SET ROLE`, não como superuser).
  - **A10 — REVOKE:** `get_preco_cockpit` não executável por `anon`.

- [ ] **Step 2: Rodar — todos verdes**

Run: `bash db/test-cockpit-preco.sh > /tmp/pg.log 2>&1; echo "PG=$?"` (checar `PG=0`; ver o log — NÃO `| tail`).

- [ ] **Step 3: Commit**

```bash
git add db/test-cockpit-preco.sh
git commit -m "test(cockpit/2a): PG17 — RPC account-aware, role-gate (falsificação), tint all-or-nothing, trigger, RLS"
```

---

## Entrega ao founder (pós-build, pós-merge)

1. **Migrations manuais (SQL Editor, nesta ordem):** BLOCO A = `20260614170000_cmc_ledger.sql` · BLOCO B = `20260614180000_markup_policy.sql` · BLOCO C = `20260614190000_get_preco_cockpit.sql` (com tint). Cada um termina com a query de validação. ⚠️ A partir do apply do BLOCO A, o `cmc_ledger` começa a acumular (sem backfill).
2. **Seed da política (opcional, BLOCO D):** `INSERT INTO markup_policy(account, escopo, piso_markup, meta_markup) VALUES ('oben','conta', <piso>, <meta>);` — até existir, o cockpit fica neutro (honesto) acima do custo, vermelho abaixo.
3. **Publish do frontend** (badge no wizard).
4. **Sem deploy de edge.**

---

## Não-objetivos (Fase 2a — repetir do spec)

Defasagem por alta de CMC (2b); snapshot econômico no `submitOrder` (2b); break-even/orçamento (v2); bloquear venda; alterar `computeTintPrice`/`get_tint_price`; derivar meta de preços históricos.

---

## Self-review do plano

- **Cobertura do spec:** custo CMC account-aware (T4) ✅ · tint all-or-nothing (T5) ✅ · markup+faixas+meta config (T2/T3/T4) ✅ · role-gate D2 (T4 + A5 falsificação) ✅ · ledger D1 (T1/A8) ✅ · degradação honesta (helper + A3/A6) ✅ · PG17 (T7) ✅ · UI faixa/número (T6) ✅. Defasagem/snapshot-no-submit = fora (2b, correto).
- **Placeholders:** identificadores tint (`tint_formulas.tint_sku_id` etc.) marcados "confirmar no schema" — é validação obrigatória do implementer via PG17, não placeholder de requisito.
- **Consistência de tipos:** `omie_codigo_produto bigint` em todas as tabelas/joins ✅ · faixa/motivo idênticos helper×RPC×testes ✅ · `markup` = % em ambos ✅.
- **Risco money-path:** a RPC é só leitura (não escreve pedido); o trigger só grava ledger (não toca o money-path de venda). Validação por PG17 com falsificação do gate.
