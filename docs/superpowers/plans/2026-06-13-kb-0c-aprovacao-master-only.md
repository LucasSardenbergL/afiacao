# KB 0c — caminho A: aprovação master-only + endurecimento de vínculos — Plano

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: usar superpowers:subagent-driven-development. Steps usam checkbox (`- [ ]`).

**Goal:** fechar o P1 de segurança (employee adultera os números que a venda exibe) elevando a escrita de `kb_product_specs` a **master-only no banco**, + endurecer as RPCs de vínculo (validar SKU, contador real, desvincular com expected-id) + CHECKs de não-negatividade — sem quebrar o fluxo do founder nem o que está em produção.

**Architecture:** 1 migration ADITIVA (RLS master-only + CHECKs + `CREATE OR REPLACE confirmar_vinculo_boletim` + nova `desvincular_boletim`) validada por PG17 com falsificação (RLS sob `SET ROLE` não-superuser + GUC `test.uid`), + guardrail mínimo de client (doc-comment + badge). Money-path → Codex adversarial no SQL final.

**Tech Stack:** Postgres/Supabase (RLS, `SECURITY DEFINER`, `has_role`), React/TS, PG17 local (`db/verify-snapshot-replay.sh` pattern).

**Spec:** `docs/superpowers/specs/2026-06-13-kb-0c-aprovacao-master-only-design.md` (§10 = adjudicação Codex + escopo final).

---

## File Structure

- Create: `supabase/migrations/20260613120000_kb_0c_aprovacao_master_only.sql` — RLS + CHECKs + 2 RPCs.
- Create: `db/test-kb-0c-aprovacao.sh` — PG17, RLS sob SET ROLE + RPCs por execução + falsificação.
- Modify: `src/hooks/useKbProductSpecs.ts` — doc-comment guardrail (admin-only; venda lê a view).
- Modify: `src/pages/AdminKnowledgeBaseDetail.tsx:100,115` — badge "Aprovado" checa `approved_at`.
- Modify: `CLAUDE.md` §10 + `docs/roadmap-sessao.md` — registro + deferidos.

---

## Task 1: Migration (banco) + PG17 dentado

**Files:**
- Create: `supabase/migrations/20260613120000_kb_0c_aprovacao_master_only.sql`
- Create: `db/test-kb-0c-aprovacao.sh`

- [ ] **Step 1: Escrever a migration (transcrição VERBATIM — money-path, não "melhorar")**

```sql
-- =========================================================================
-- KB 0c — caminho A: aprovação de spec MASTER-ONLY + endurecimento de vínculos.
-- ⚠️ MIGRATION MANUAL: colar no SQL Editor do Lovable (CLAUDE.md §5). ADITIVO.
-- Continuação de 20260611140000_kb_fundacao_casamento.sql.
-- Spec: docs/superpowers/specs/2026-06-13-kb-0c-aprovacao-master-only-design.md
-- =========================================================================

-- BLOCO A: aprovação master-only — fecha o P1 (employee adulterava os números da venda).
-- A RLS antiga deixava INSERT por qualquer staff e UPDATE por extracted_by=auth.uid() (de QUALQUER coluna).
-- Curadoria da base é do founder (V1-C) → escrita SÓ master. SELECT (staff) e DELETE (master) ficam INTACTAS.
DROP POLICY IF EXISTS "kb_product_specs_insert_staff"  ON public.kb_product_specs;
DROP POLICY IF EXISTS "kb_product_specs_update_master" ON public.kb_product_specs;

CREATE POLICY "kb_product_specs_insert_master" ON public.kb_product_specs
  FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'master'::app_role));

CREATE POLICY "kb_product_specs_update_master" ON public.kb_product_specs
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::app_role));

-- BLOCO B: CHECKs de não-negatividade nos campos numéricos que a venda exibe pela view
-- (Codex P2: extração errada não publica rendimento negativo / catalisador absurdo). Base vazia → ADD direto.
ALTER TABLE public.kb_product_specs
  DROP CONSTRAINT IF EXISTS kb_spec_rendimento_nonneg,
  DROP CONSTRAINT IF EXISTS kb_spec_demaos_nonneg,
  DROP CONSTRAINT IF EXISTS kb_spec_potlife_nonneg,
  DROP CONSTRAINT IF EXISTS kb_spec_validade_nonneg,
  DROP CONSTRAINT IF EXISTS kb_spec_catalisador_pct_nonneg;
ALTER TABLE public.kb_product_specs
  ADD CONSTRAINT kb_spec_rendimento_nonneg      CHECK (rendimento_m2_por_litro   IS NULL OR rendimento_m2_por_litro   >= 0),
  ADD CONSTRAINT kb_spec_demaos_nonneg          CHECK (demaos_recomendadas       IS NULL OR demaos_recomendadas       >= 0),
  ADD CONSTRAINT kb_spec_potlife_nonneg         CHECK (pot_life_horas            IS NULL OR pot_life_horas            >= 0),
  ADD CONSTRAINT kb_spec_validade_nonneg        CHECK (validade_dias            IS NULL OR validade_dias            >= 0),
  ADD CONSTRAINT kb_spec_catalisador_pct_nonneg CHECK (catalisador_proporcao_pct IS NULL OR catalisador_proporcao_pct >= 0);

-- BLOCO C: confirmar_vinculo_boletim — + valida SKU em omie_products (P2-a) + contador real (P3, ROW_COUNT).
-- Resto VERBATIM da 20260611140000: gate master, spec existe, anti-roubo, ON CONFLICT DO NOTHING.
-- (CREATE OR REPLACE preserva os GRANTs já dados na fundação — mesma assinatura uuid,jsonb.)
CREATE OR REPLACE FUNCTION public.confirmar_vinculo_boletim(
  p_kb_product_spec_id uuid, p_skus jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item jsonb; v_account text; v_cod bigint; v_count integer := 0; v_dono uuid; v_ins integer;
BEGIN
  IF NOT public.has_role(v_uid, 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kb_product_specs WHERE id = p_kb_product_spec_id) THEN
    RAISE EXCEPTION 'spec inexistente';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_account := v_item->>'account';
    v_cod := (v_item->>'omie_codigo_produto')::bigint;
    -- P2-a: o SKU tem que existir no catálogo Omie (mata vínculo-fantasma: account vazio/caixa errada/SKU inexistente).
    IF NOT EXISTS (SELECT 1 FROM public.omie_products
                    WHERE omie_codigo_produto = v_cod AND account = v_account) THEN
      RAISE EXCEPTION 'SKU %/% inexistente em omie_products', v_account, v_cod;
    END IF;
    SELECT kb_product_spec_id INTO v_dono FROM public.omie_product_spec_links
      WHERE account = v_account AND omie_codigo_produto = v_cod AND status = 'confirmed';
    IF v_dono IS NOT NULL AND v_dono <> p_kb_product_spec_id THEN
      RAISE EXCEPTION 'SKU %/% já vinculado a outro boletim', v_account, v_cod;
    END IF;
    INSERT INTO public.omie_product_spec_links
      (account, omie_codigo_produto, kb_product_spec_id, status, confirmed_by)
    VALUES (v_account, v_cod, p_kb_product_spec_id, 'confirmed', v_uid)
    ON CONFLICT (account, omie_codigo_produto, kb_product_spec_id, status) DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;     -- P3: só conta o que REALMENTE inseriu (DO NOTHING → 0).
    v_count := v_count + v_ins;
  END LOOP;
  RETURN v_count;
END;
$$;

-- BLOCO D: desvincular_boletim — desfaz/reatribui um 'confirmed' errado (master).
-- p_expected_kb_product_spec_id evita STALE-DELETE (Codex P2): aba atrasada não apaga vínculo já reatribuído.
CREATE OR REPLACE FUNCTION public.desvincular_boletim(
  p_account text, p_omie_codigo_produto bigint, p_expected_kb_product_spec_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted integer;
BEGIN
  IF NOT public.has_role(auth.uid(), 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  DELETE FROM public.omie_product_spec_links
   WHERE account = p_account
     AND omie_codigo_produto = p_omie_codigo_produto
     AND status = 'confirmed'
     AND kb_product_spec_id = p_expected_kb_product_spec_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;     -- 0 = nada batia (não vinculado, ou já reatribuído = stale UI).
END;
$$;

REVOKE ALL ON FUNCTION public.desvincular_boletim(text, bigint, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.desvincular_boletim(text, bigint, uuid) TO authenticated;
```

- [ ] **Step 2: Escrever `db/test-kb-0c-aprovacao.sh`** modelando o bring-up de `db/test-kb-fundacao-casamento.sh` (copiar o cabeçalho de bring-up PG17 keg-only + stubs + as 3 migrations da fundação `20260517170000`/`20260517180000`/`20260611140000`), **acrescentando a migration nova** `20260613120000` por último, e os asserts abaixo. Porta dedicada (ex. `5441`). Disciplina de assert negativo (captura SQLSTATE/mensagem e re-lança o resto).

Setup extra (após as migrations, antes dos asserts):
```sql
-- Grants p/ a RLS ser o que filtra sob SET ROLE (sem grant = "permission denied for table", não RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_product_specs TO authenticated;
-- Seeds: master (…000a), employee (…000b) já vêm do bloco padrão; + 1 SKU omie p/ o confirmar.
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo)
  VALUES (8001, 'PRD8001', 'VERNIZ PU XX01.0001.00GL', 'oben', true) ON CONFLICT DO NOTHING;
```

Asserts (todos via `psql`; os de RLS usam `SET ROLE authenticated` + `SET LOCAL test.uid`; `RESET ROLE` no fim de cada bloco):

- **B1 — RLS: master INSERTA, employee NÃO.**
  - `SET ROLE authenticated; SET LOCAL test.uid='…000a'` (master) → `INSERT INTO kb_product_specs(product_code,product_name,supplier) VALUES('B1.0001.00','m','sayerlack')` → **OK**. `RESET ROLE`.
  - `SET ROLE authenticated; SET LOCAL test.uid='…000b'` (employee) → o mesmo INSERT (outro code) → **DEVE falhar** com `insufficient_privilege` (SQLSTATE `42501`, "row-level security"). Captura e re-lança se a SQLSTATE for outra. `RESET ROLE`.
- **B2 — RLS: employee NÃO atualiza nem o próprio `extracted_by` (o furo do P1).**
  - Como postgres, semeia 1 spec com `extracted_by='…000b'` (employee) e `approved_at=now()`.
  - `SET ROLE authenticated; SET LOCAL test.uid='…000b'` → `UPDATE kb_product_specs SET rendimento_m2_por_litro=999 WHERE id=<seed>`; `GET DIAGNOSTICS r=ROW_COUNT` → **r DEVE ser 0** (USING master-only não enxerga a linha; UPDATE no-op, SEM erro). Conferir que `rendimento_m2_por_litro` segue NULL. `RESET ROLE`.
  - `SET ROLE authenticated; SET LOCAL test.uid='…000a'` (master) → o mesmo UPDATE → **r=1** e valor gravado. `RESET ROLE`.
- **B3 — FALSIFICAÇÃO da RLS (prova que B2 tem dente):** re-cria a policy ANTIGA furada (`USING (has_role master OR extracted_by = auth.uid())`); re-roda o UPDATE do employee-dono → agora **r=1** (passou) → captura `SABOTAGEM_PASSOU`. Se NÃO passar, B2 é teatro → falha o script. Depois **restaura** a policy correta (re-aplica `20260613120000`) e re-prova que o employee volta a 0 linhas.
- **B4 — confirmar_vinculo valida SKU (P2-a):** master (`test.uid=…000a`, chamada como postgres via GUC, igual A5 da fundação) →
  - `confirmar_vinculo_boletim(<spec>, '[{"account":"oben","omie_codigo_produto":8001}]')` → retorna 1 (SKU existe).
  - `confirmar_vinculo_boletim(<spec>, '[{"account":"oben","omie_codigo_produto":999999}]')` → **RAISE** `%inexistente em omie_products%`.
  - `confirmar_vinculo_boletim(<spec>, '[{"account":"OBEN","omie_codigo_produto":8001}]')` (caixa errada) → **RAISE** `%inexistente%` (sem coerção). Captura/re-lança.
- **B5 — contador ROW_COUNT (P3):** master confirma (oben,8001)→spec **duas vezes** seguidas; a 2ª chamada (mesmo dono, `ON CONFLICT DO NOTHING`) → **retorna 0** (não 1); `count(*) confirmed` segue 1.
- **B6 — desvincular_boletim:** master confirma (oben,8001)→specA.
  - `desvincular_boletim('oben',8001,<id_errado>)` (expected ≠ dono) → **retorna 0** (stale-delete evitado; nada apagado). `count confirmed` = 1.
  - `desvincular_boletim('oben',8001,<specA>)` → **retorna 1**; `count confirmed` = 0 (SKU liberado).
  - reatribuir: confirmar (oben,8001)→specB agora **OK** (SKU livre).
  - gate: `SET ROLE`/GUC employee chamando `desvincular_boletim` → **RAISE** `%forbidden%`/`%master%`.
- **B7 — CHECK de não-negatividade:** como master, `INSERT kb_product_specs(... rendimento_m2_por_litro=-1 ...)` → **DEVE falhar** `check_violation` (`kb_spec_rendimento_nonneg`); `=0` e NULL → OK.

- [ ] **Step 3: Rodar o teste até VERDE + falsificação provada**

Run: `bash db/test-kb-0c-aprovacao.sh > /tmp/kb0c.log 2>&1; echo "EXIT=$?"` (⚠️ NUNCA `| tail` — engole o exit; CLAUDE.md §2). `grep -E "FALHOU|EXIT=" /tmp/kb0c.log`.
Expected: `EXIT=0` + "todos os asserts passaram (B1..B7)". Se B3 (falsificação) não detectar a sabotagem, o script falha — corrigir o assert, não desativar.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260613120000_kb_0c_aprovacao_master_only.sql db/test-kb-0c-aprovacao.sh
git commit -m "feat(kb): 0c-A — aprovação master-only + valida SKU + desvincular + CHECKs (PG17 dentado)"
```

---

## Task 2: Guardrail de client (sem mudança de comportamento de escrita)

**Files:**
- Modify: `src/hooks/useKbProductSpecs.ts`
- Modify: `src/pages/AdminKnowledgeBaseDetail.tsx`

- [ ] **Step 1: doc-comment em `useKbProductSpecs`** (acima da `export function`):

```ts
/**
 * ⚠️ ADMIN-ONLY. Lê a ficha por `product_code` SEM filtrar `approved_at` (o detalhe precisa
 * ver o rascunho). A VENDA/COPILOT NUNCA devem usar este hook — leem a fonte única
 * `v_omie_product_current_spec` (dupla-trava confirmed + approved_at). Ver
 * docs/superpowers/specs/2026-06-13-kb-0c-aprovacao-master-only-design.md §4e.
 */
```

- [ ] **Step 2: badge "Aprovado" honesto** em `AdminKnowledgeBaseDetail.tsx` — trocar `{existingSpecs && (` (linha ~100, o badge) por `{existingSpecs?.approved_at && (` para o badge refletir `approved_at` (o grid de KPIs `{existingSpecs ? ...}` segue como está). Não tocar a query.

- [ ] **Step 3: gate `validate` local**

Run: `bun run typecheck > /tmp/tc.log 2>&1; echo "TC=$?"` ; `bun run test > /tmp/t.log 2>&1; echo "T=$?"` ; `bun lint 2>&1 | tail -5`
Expected: `TC=0`, `T=0`, lint sem novos erros.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useKbProductSpecs.ts src/pages/AdminKnowledgeBaseDetail.tsx
git commit -m "feat(kb): guardrail — useKbProductSpecs admin-only + badge Aprovado checa approved_at"
```

---

## Task 3: Codex adversarial no SQL final + registro

**Files:**
- Modify: `CLAUDE.md` (§10), `docs/roadmap-sessao.md`
- Regenerar: `docs/migrations-audit.md`, `scripts/audit-custom-migrations.sql` (via `bun run audit:migrations`)

- [ ] **Step 1: Codex adversarial** (xhigh) na migration final + no teste: `codex exec "<brief: revise a migration 20260613120000 e o db/test-kb-0c-aprovacao.sh — money-path; ache furo de RLS/gate/idempotência>" -C "$(pwd)" -s read-only -c 'model_reasoning_effort="xhigh"' < /dev/null` (timeout 600). Folder os P1/P2; se cota esgotada → Caminho B (auto-review documentado).
- [ ] **Step 2: `bun run audit:migrations`** (regenera o inventário; resolve o conflito recorrente do audit) e conferir que a nova migration aparece.
- [ ] **Step 3: CLAUDE.md §10** — adicionar entrada do 0c-path-A (o que mudou, PG17, Codex) + os **deferidos** (4b multi-fornecedor, orphan-on-code-change=path-B, queue-thrash=0b-hardening-ledger, omie_products FOR ALL). `docs/roadmap-sessao.md` atualizado.
- [ ] **Step 4: Commit + push + PR** com o body marcando **⚠️ migration manual** + o SQL inline (1 bloco) + a query de validação pós-apply. Auto-merge `--squash --auto`.

---

## Notas de execução (controller)

- **Migration manual** (CLAUDE.md §5): o founder cola `20260613120000` no SQL Editor — **junto/depois** da `20260611140000` (que ainda não foi aplicada). Entregar os 2 blocos na ordem.
- **Sem deploy de edge** (nenhuma edge muda). **Publish** do front só pro guardrail/badge (cosmético; não bloqueia).
- **Pré-requisito de consumo:** esta migration + a 0a devem estar aplicadas ANTES de a venda (path-B) ler a view. Até lá nada exposto (A1 do spec).
