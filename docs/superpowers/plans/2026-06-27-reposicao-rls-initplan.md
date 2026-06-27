# Reposição RLS `has_role` → InitPlan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar o HTTP 500 intermitente de `v_oportunidade_economica_hoje` reescrevendo 36 RLS policies de 15 tabelas base para avaliar `has_role` como InitPlan (1×/statement) em vez de por-linha — sem alterar uma vírgula da autorização.

**Architecture:** `ALTER POLICY` atômico em cada policy, envolvendo a expressão `has_role` num `(SELECT …)` escalar + `auth.uid()`→`(SELECT auth.uid())`. Migration custom aplicada manual no SQL Editor (`lovable-db-operator`), provada antes num harness PG17 (`prove-sql-money-path`) que aplica a migration REAL, prova equivalência old↔new + preservação de catálogo + InitPlan, e falsifica. Spec: [docs/superpowers/specs/2026-06-27-reposicao-rls-initplan-oportunidade-economica-design.md](../specs/2026-06-27-reposicao-rls-initplan-oportunidade-economica-design.md).

**Tech Stack:** PostgreSQL 16 (prod Supabase) / 17 (harness local) · plpgsql RLS · bash+psql harness · React Query (frontend adjacente).

---

## File Structure

- `supabase/migrations/<TS>_reposicao_rls_initplan.sql` — **criar.** Os 36 `ALTER POLICY` + header + query de validação pós-apply. `<TS>` = timestamp **depois** de `20260627150000` (#1098) — confirmar o último na hora.
- `db/test-reposicao-rls-initplan.sh` — **criar.** Harness PG17 espelhando [`db/test-tint-formulas-rls-initplan.sh`](../../../db/test-tint-formulas-rls-initplan.sh) (#1098), adaptado p/ 15 tabelas + assert de catálogo.
- `src/hooks/useReposicaoSessao.ts` — **modificar** (Task 6, PR-irmão separado): degradação honesta + consumir cache compartilhado.
- `src/components/AppShell.tsx` — **modificar** (Task 6): extrair o count OBEN p/ hook compartilhado + degradação honesta.
- `docs/migrations-audit.md` + `supabase/schema-snapshot.sql` — regenerados pós-apply (Task 7).

**Fonte dos artefatos SQL (já gerados read-only de prod, determinísticos):** os 36 `ALTER POLICY` (Task 1) e os 36 `CREATE POLICY` raw do fixture (Task 2) foram gerados via `pg_policies` + `format()`; reproduzíveis pela query no rodapé de cada task.

---

## Task 1: Migration (os 36 ALTER POLICY)

**Files:**
- Create: `supabase/migrations/<TS>_reposicao_rls_initplan.sql`

- [ ] **Step 1: Pré-flight — reler o estado de prod e confirmar não-drift**

Confirmar que as 36 policies em prod ainda batem com o esperado (apply manual pode ter divergido) e que nenhuma worktree as reescreveu:

```bash
~/.config/afiacao/psql-ro -tAc "
select count(*) from pg_policies
where schemaname='public'
  and tablename = any(array['venda_items_history','sku_leadtime_history','sku_parametros','sku_grupo_producao','inventory_position','fornecedor_grupo_producao','fornecedor_cadeia_logistica','fornecedor_habilitado_reposicao','fornecedor_aumento_item','fornecedor_aumento_anunciado','promocao_campanha','promocao_item','omie_products','empresa_configuracao_custos','categoria_aumento_familia_mapeamento'])
  and (qual ilike '%has_role%' or with_check ilike '%has_role%')
  and (coalesce(qual,with_check) not ilike '%( select%' and coalesce(qual,with_check) not ilike '%(select%');"
```

Expected: `36` (todas ainda RAW). Se ≠ 36, alguém já mexeu — reconciliar antes de prosseguir.

- [ ] **Step 2: Escrever a migration**

Conteúdo exato (gerado de prod; preserva `cmd`/`roles`/`permissive`/redundâncias; `USING` só onde havia `qual`, `WITH CHECK` só onde havia `with_check`):

```sql
-- =============================================================================
-- REPOSIÇÃO — RLS has_role por-linha → InitPlan O(1) (mata o 500 de
-- v_oportunidade_economica_hoje). ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor.
--
-- Bug: 36 policies de 15 tabelas base chamam has_role(auth.uid(),…) DIRETO no
-- USING/WITH CHECK. has_role é SECURITY DEFINER STABLE → o planner NÃO inlina e
-- avalia POR LINHA. Sob a view security_invoker (RLS desce a ~20 tabelas) +
-- explosão do generate_series (~537k linhas), o count do badge toca ~3,8GB e
-- estoura statement_timeout=8s do authenticated em cache frio → PostgREST 500.
-- Provado read-only: estrutural 885ms/11k buffers SEM RLS vs 495k buffers COM.
--
-- Fix: envolver a expressão num (SELECT …) escalar → InitPlan (1×/statement).
-- Semântica IDÊNTICA (mesma função, mesmo resultado: staff vê, não-staff não),
-- só muda o plano. Mesmo padrão de 20260613130000 (radar) e #1098 (tint).
-- ALTER POLICY (atômico, preserva cmd/roles/permissive, sem janela fail-closed,
-- idempotente). Gerado do estado REAL por-policy (não inventa cláusula).
-- Provado em PG17: db/test-reposicao-rls-initplan.sh.
-- =============================================================================

ALTER POLICY "Admin/manager editam categoria_aumento_familia_mapeamento" ON public.categoria_aumento_familia_mapeamento
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff lê categoria_aumento_familia_mapeamento" ON public.categoria_aumento_familia_mapeamento
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_empresa_configuracao_custos_delete ON public.empresa_configuracao_custos
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_empresa_configuracao_custos_insert ON public.empresa_configuracao_custos
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_empresa_configuracao_custos_select ON public.empresa_configuracao_custos
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_empresa_configuracao_custos_update ON public.empresa_configuracao_custos
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Admin/manager editam fornecedor_aumento_anunciado" ON public.fornecedor_aumento_anunciado
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff lê fornecedor_aumento_anunciado" ON public.fornecedor_aumento_anunciado
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Admin/manager editam fornecedor_aumento_item" ON public.fornecedor_aumento_item
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff lê fornecedor_aumento_item" ON public.fornecedor_aumento_item
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_cadeia_logistica_delete ON public.fornecedor_cadeia_logistica
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_cadeia_logistica_insert ON public.fornecedor_cadeia_logistica
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_cadeia_logistica_select ON public.fornecedor_cadeia_logistica
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_cadeia_logistica_update ON public.fornecedor_cadeia_logistica
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_grupo_producao_delete ON public.fornecedor_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_grupo_producao_insert ON public.fornecedor_grupo_producao
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_grupo_producao_select ON public.fornecedor_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_grupo_producao_update ON public.fornecedor_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_habilitado_reposicao_delete ON public.fornecedor_habilitado_reposicao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_habilitado_reposicao_insert ON public.fornecedor_habilitado_reposicao
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_habilitado_reposicao_select ON public.fornecedor_habilitado_reposicao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_habilitado_reposicao_update ON public.fornecedor_habilitado_reposicao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Staff can manage inventory" ON public.inventory_position
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_inventory_position_select ON public.inventory_position
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff can manage products" ON public.omie_products
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Admin/manager/master editam campanhas" ON public.promocao_campanha
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff vê campanhas" ON public.promocao_campanha
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Admin/manager/master editam itens" ON public.promocao_item
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff vê itens" ON public.promocao_item
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_grupo_producao_delete ON public.sku_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_grupo_producao_insert ON public.sku_grupo_producao
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_grupo_producao_select ON public.sku_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_grupo_producao_update ON public.sku_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_leadtime_history_all ON public.sku_leadtime_history
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY staff_sku_parametros_select ON public.sku_parametros
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY staff_venda_items_history_select ON public.venda_items_history
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

-- Validação pós-apply: as 36 devem ter virado InitPlan (subselect) e preservado cmd/roles/permissive.
SELECT count(*) AS policies_wrapped_esperado_36
FROM pg_policies
WHERE schemaname='public'
  AND tablename = ANY(ARRAY['venda_items_history','sku_leadtime_history','sku_parametros','sku_grupo_producao','inventory_position','fornecedor_grupo_producao','fornecedor_cadeia_logistica','fornecedor_habilitado_reposicao','fornecedor_aumento_item','fornecedor_aumento_anunciado','promocao_campanha','promocao_item','omie_products','empresa_configuracao_custos','categoria_aumento_familia_mapeamento'])
  AND (qual ILIKE '%( select%' OR qual ILIKE '%(select%' OR with_check ILIKE '%( select%' OR with_check ILIKE '%(select%');
```

- [ ] **Step 3: Verificar idempotência sintática (psql `--single-transaction` dry-run via PG17)** — coberto pelo harness na Task 3 (o harness aplica esta migration REAL). Sem commit aqui.

**Regerar (se prod divergiu no pré-flight):** rodar a query geradora em `scratchpad/alters_gerados.sql` (documentada na spec §4) — `select string_agg(format('ALTER POLICY %I ON public.%I …', …))` com `replace(qual,'auth.uid()','(SELECT auth.uid())')`.

---

## Task 2: Fixture do estado raw (para o harness instalar prod antes de aplicar a migration)

**Files:**
- Create: bloco inline em `db/test-reposicao-rls-initplan.sh` (não é arquivo separado).

- [ ] **Step 1: Os 36 `CREATE POLICY` raw** (estado de prod hoje) — gerados de prod, instalados sobre tabelas mínimas no harness. Forma (1 por policy; preserva permissive/cmd/roles/qual/with_check):

```sql
CREATE POLICY "Admin/manager editam categoria_aumento_familia_mapeamento" ON public.categoria_aumento_familia_mapeamento AS PERMISSIVE FOR ALL TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
-- … (36 no total; conteúdo completo em scratchpad/create_policy_raw.sql, gerado pela query abaixo)
```

Query geradora (read-only, reproduz o fixture exato):

```bash
~/.config/afiacao/psql-ro -tA -c "
select string_agg(format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
  policyname, tablename, permissive, cmd, array_to_string(roles, ', '),
  case when qual is not null then ' USING (' || qual || ')' else '' end,
  case when with_check is not null then ' WITH CHECK (' || with_check || ')' else '' end), E'\n'
  order by tablename, cmd, policyname)
from pg_policies where schemaname='public'
  and tablename = any(array['venda_items_history','sku_leadtime_history','sku_parametros','sku_grupo_producao','inventory_position','fornecedor_grupo_producao','fornecedor_cadeia_logistica','fornecedor_habilitado_reposicao','fornecedor_aumento_item','fornecedor_aumento_anunciado','promocao_campanha','promocao_item','omie_products','empresa_configuracao_custos','categoria_aumento_familia_mapeamento'])
  and (qual ilike '%has_role%' or with_check ilike '%has_role%');"
```

Expected: 36 `CREATE POLICY`. (As tabelas são mínimas — só `id uuid` — porque NENHUMA policy referencia coluna; verificado read-only.)

---

## Task 3: Harness PG17 (`prove-sql-money-path`)

**Files:**
- Create: `db/test-reposicao-rls-initplan.sh`

**Estrutura** (espelha [`db/test-tint-formulas-rls-initplan.sh`](../../../db/test-tint-formulas-rls-initplan.sh) — copiar o boilerplate de initdb/start/stubs/`auth.uid`/`has_role`/contador; trocar a parte de schema+asserts pelo abaixo).

- [ ] **Step 1: Infra + 15 tabelas mínimas + fixture raw + seed**

```bash
TABS="categoria_aumento_familia_mapeamento empresa_configuracao_custos fornecedor_aumento_anunciado fornecedor_aumento_item fornecedor_cadeia_logistica fornecedor_grupo_producao fornecedor_habilitado_reposicao inventory_position omie_products promocao_campanha promocao_item sku_grupo_producao sku_leadtime_history sku_parametros venda_items_history"
# enum + user_roles + has_role VERBATIM prod + auth stubs + service_role BYPASSRLS  (igual #1098)
# tabelas mínimas + RLS + grants:
for t in $TABS; do
  P -q -c "CREATE TABLE public.$t (id uuid primary key default gen_random_uuid());
           ALTER TABLE public.$t ENABLE ROW LEVEL SECURITY;
           GRANT SELECT,INSERT,UPDATE,DELETE ON public.$t TO authenticated, anon;
           INSERT INTO public.$t SELECT gen_random_uuid() FROM generate_series(1,50);"
done
P -q -f "$FIXTURE_RAW"   # os 36 CREATE POLICY raw (Task 2)
```

- [ ] **Step 2: Capturar matriz OLD (visibilidade) + catálogo OLD**

```bash
# helper: conta linhas visíveis p/ um caller numa tabela (mede a RLS)
cnt() { Pq -c "SET test.uid='$2'; SET ROLE authenticated; SELECT count(*) FROM public.$1;" | tail -1; }
cnt_anon() { Pq -c "SET ROLE anon; SELECT count(*) FROM public.$1;" | tail -1; }
# matriz OLD: para cada tabela × caller (master/employee/customer/norole/null/anon) → arquivo
snapshot_matrix() { for t in $TABS; do for c in "$MASTER" "$EMP" "$CUST" "$NOROLE" ""; do echo "$t|$c|$(cnt "$t" "$c")"; done; echo "$t|anon|$(cnt_anon "$t")"; done; }
snapshot_matrix > "$MATRIX_OLD"
# catálogo OLD: (cmd, roles ordenados, permissive, tem_using, tem_check) por policy — SEM o texto
snapshot_catalog() { Pq -c "select polrelid::regclass::text||'|'||polname||'|'||polcmd||'|'||polpermissive||'|'||(polqual is not null)||'|'||(polwithcheck is not null)||'|'||array_to_string(array(select rolname from pg_roles where oid=any(polroles) order by 1),',') from pg_policy where polrelid::regclass::text = any(string_to_array('$(echo $TABS|tr ' ' ',')',',')) order by 1,2;"; }
snapshot_catalog > "$CATALOG_OLD"
```

- [ ] **Step 3: Aplicar a migration REAL + capturar NEW**

```bash
MIG="$REPO_ROOT/supabase/migrations/<TS>_reposicao_rls_initplan.sql"
P -q -f "$MIG" >/dev/null
snapshot_matrix > "$MATRIX_NEW"; snapshot_catalog > "$CATALOG_NEW"
```

- [ ] **Step 4: Asserts**

```bash
# A1 — EQUIVALÊNCIA: a RLS admite EXATAMENTE os mesmos callers (visibilidade) old↔new
if diff -q "$MATRIX_OLD" "$MATRIX_NEW" >/dev/null; then ok "A1 matriz de visibilidade idêntica old↔new (15 tabelas × 6 callers)"; else bad "A1 matriz DIVERGIU:"; diff "$MATRIX_OLD" "$MATRIX_NEW"; fi
# A2 — CATÁLOGO: cmd/roles/permissive/presença-using/presença-check idênticos (anti-drift)
if diff -q "$CATALOG_OLD" "$CATALOG_NEW" >/dev/null; then ok "A2 catálogo de policy preservado (cmd/roles/permissive/clauses)"; else bad "A2 catálogo DRIFTOU:"; diff "$CATALOG_OLD" "$CATALOG_NEW"; fi
# A3 — WRAP aplicado: as 36 contêm (SELECT no texto NEW
W=$(Pq -c "select count(*) from pg_policies where schemaname='public' and tablename=any(string_to_array('$(echo $TABS|tr ' ' ',')',',')) and (qual ilike '%(select%' or with_check ilike '%(select%');")
eq "A3 36 policies wrapped (InitPlan)" "$W" "36"
# A4 — AUTZ ABSOLUTA (sanity): não-staff vê 0 em TODA tabela; master vê 50 em toda tabela
for t in $TABS; do
  eq "A4.$t customer vê 0" "$(cnt "$t" "$CUST")" "0"
  eq "A4.$t anon vê 0"     "$(cnt_anon "$t")"     "0"
  eq "A4.$t master vê 50"  "$(cnt "$t" "$MASTER")" "50"
done
# A5 — WITH CHECK: master insere; customer barra; e a CLASSE master-only (categoria/aumento/promocao)
#      barra employee no INSERT (FOR ALL master-only) mas deixa LER (policy SELECT permissiva).
ins_ok() { P -tA 2>&1 -c "SET test.uid='$2'; SET ROLE authenticated; DO \$\$ BEGIN INSERT INTO public.$1 DEFAULT VALUES; RAISE NOTICE 'OK'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'DENY'; WHEN OTHERS THEN RAISE; END \$\$;" | grep -oE 'OK|DENY' | tail -1; }
eq "A5 master INSERT venda? (n/a SELECT-only)"; # venda/sku_parametros são SELECT-only → sem WITH CHECK; pular
eq "A5a master INSERT inventory_position" "$(ins_ok inventory_position "$MASTER")" "OK"
eq "A5b customer INSERT inventory_position barrado" "$(ins_ok inventory_position "$CUST")" "DENY"
eq "A5c employee INSERT promocao_item barrado (master-only WITH CHECK)" "$(ins_ok promocao_item "$EMP")" "DENY"
eq "A5d master INSERT promocao_item" "$(ins_ok promocao_item "$MASTER")" "OK"
```

- [ ] **Step 5: InitPlan via contador** (instrumentar `has_role` com `nextval`, igual #1098 A6) — 1 representante por shape: `venda_items_history` (S1), `promocao_item` (S2/S3), `sku_parametros` (S4). SELECT de 50 linhas → `has_role` chamado ≤ 6 (não ≥50).

```bash
for t in venda_items_history promocao_item sku_parametros; do
  Pq -c "SELECT setval('public._hr_calls',1,false);" >/dev/null
  Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.$t;" >/dev/null
  K=$(Pq -c "SELECT last_value FROM public._hr_calls;")
  if [ "${K:-99}" -le 6 ]; then ok "A6.$t InitPlan (${K}× p/ 50 linhas)"; else bad "A6.$t por-linha (${K}×)"; fi
done
```

- [ ] **Step 6: FALSIFICAÇÃO** (cada sabotagem exige vermelho; restaurar `$MIG` depois)

```bash
# F1 — alargar role: trocar authenticated→public numa policy authenticated NÃO muda visibilidade aqui,
#      mas o assert A2 (catálogo) tem de pegar. Sabotar: recriar uma policy com role public.
P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history TO public USING ((SELECT has_role((SELECT auth.uid()),'master'::app_role)));"
snapshot_catalog > "$CATALOG_SAB"
if ! diff -q "$CATALOG_OLD" "$CATALOG_SAB" >/dev/null; then ok "F1 A2 tem dente (pegou role authenticated→public)"; else bad "F1 catálogo não pegou o alargamento de role"; fi
P -q -f "$MIG" >/dev/null
# F2 — USING(true) numa tabela → customer passa a ver tudo (A4 tem dente)
P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history USING (true);"
SAB=$(cnt venda_items_history "$CUST")
if [ "${SAB:-0}" != "0" ]; then ok "F2 A4 tem dente (USING(true) vazou ${SAB} p/ customer)"; else bad "F2 customer ainda vê 0 com USING(true)"; fi
P -q -f "$MIG" >/dev/null
# F3 — omitir o wrap (has_role direto) → contador alto (A6 tem dente)
P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));"
# (com has_role instrumentado) SELECT 50 linhas → K alto
... (igual #1098 F2: setval, select, checar K>=50) ...
P -q -f "$MIG" >/dev/null
```

- [ ] **Step 7: Rodar verde**

Run: `heavy bash db/test-reposicao-rls-initplan.sh > /tmp/t.log 2>&1; echo $?`
Expected: `✅ HARNESS VERDE`, exit `0`.

---

## Task 4: Codex adversarial do código (money-path — xhigh)

- [ ] **Step 1:** Após o harness verde, rodar `/codex challenge` (ou consult xhigh) sobre a migration + o harness. Prompt com os fatos embutidos (NÃO abrir `schema-snapshot.sql`); focar: algum ALTER que muda autz? assert de catálogo cobre todos os drifts? a falsificação tem dente real? edge de NULL uid / role public? Acatar/registrar achados. (Cota Codex = janela 7d; este é o ponto crítico — priorizar sobre o challenge de metodologia já feito.)

---

## Task 5: Handoff `lovable-db-operator` (escrita + medição do founder)

- [ ] **Step 1:** Empacotar via skill `lovable-db-operator`: bloco `🟣 Lovable → SQL Editor` com a migration; query de validação pós-apply (a do Step 2 da Task 1, espera 36); nota de PR "⚠️ migration manual".
- [ ] **Step 2:** Anexar o **bloco de medição** p/ o founder rodar no SQL Editor (gate objetivo da spec §6):

```sql
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"414a9727-ad1d-4998-914e-9c6ccf26cf50","role":"authenticated"}';
set local statement_timeout='60s';
explain (analyze, buffers, settings, verbose)
  select count(*) from v_oportunidade_economica_hoje where empresa='OBEN';
rollback;
```

Rodar ANTES (raspa os 8s / 495k buffers) e DEPOIS (esperado: buffers caem à ordem estrutural, zero has_role por-linha, tempo confortável < 8s). Avaliar contra o gate: se warm > ~1s ou cold > ~3s → Fase 2 (materializar) vira mandatória.

- [ ] **Step 3:** Pós-apply confirmado: reconciliar `schema_migrations` + regenerar `supabase/schema-snapshot.sql` (database.md §3) + `bun run audit:migrations`.

---

## Task 6: PR-irmão de frontend (degradação honesta + dedupe) — SEPARADO, não bloqueia/não polui a medição

**Files:**
- Modify: `src/hooks/useReposicaoSessao.ts:96-130`
- Modify: `src/components/AppShell.tsx:442-456`

- [ ] **Step 1:** Extrair o count OBEN p/ um hook compartilhado `useOportunidadesAtivasCount()` (queryKey `['oportunidades-ativas-count','OBEN']`, `staleTime` 30s, `refetchInterval` 60s) que **degrada honesto**: `onError → return null` (não `throw`, não `0`); o badge mostra `count ?? '—'` (ausente ≠ zero). [AppShell.tsx:443](../../../src/components/AppShell.tsx) e [useReposicaoSessao.ts:102](../../../src/hooks/useReposicaoSessao.ts) passam a consumir esse hook (mesma cache → 1 request/60s em vez de 2).
- [ ] **Step 2:** Em `useReposicaoSessao`, trocar `if (oport.error) throw oport.error` por: se erro, `oportunidadesCount = null` e `deriveCurrentStep` trata `null` como "indeterminado" (não força etapa 1). Verificar typecheck/lint/test.
- [ ] **Step 3:** Commit separado / PR-irmão draft.

---

## Task 7: Commit + audit + PR draft

- [ ] **Step 1:** `bun run audit:migrations` (regenera `docs/migrations-audit.md`). 
- [ ] **Step 2:** Commit (migration + harness + spec + plan + audit). PR **DRAFT** até o founder aplicar + medir (auto-merge só dispara em não-draft; manter draft segura).
- [ ] **Step 3:** Corpo do PR: ⚠️ migration manual + bloco SQL Editor + bloco de medição + checklist de deploy (`lovable-deploy-verify`).

---

## Self-Review

- **Spec coverage:** §1 diagnóstico → Task 5 medição; §3 escopo 36 policies → Task 1 (migration) cobre as 36; §4 fix → Task 1; §5 prova (equivalência/catálogo/InitPlan/falsificação) → Task 3 A1/A2/A6/F1-F3; §6 medição+gate → Task 5; §7 handoff → Task 5; §8 frontend → Task 6; §9 Fase 2 → fora deste plano (condicional). ✅ sem gaps.
- **Placeholders:** `<TS>` (timestamp da migration) é o único — intencional (definido na criação, depende do último timestamp p/ ordem multi-sessão); todo resto é conteúdo real. Step 6/F3 referencia "igual #1098 F2" com o mecanismo descrito.
- **Type consistency:** `cnt`/`cnt_anon`/`ins_ok`/`snapshot_matrix`/`snapshot_catalog` usados consistentemente; `$MATRIX_OLD/NEW`, `$CATALOG_OLD/NEW`, `$FIXTURE_RAW`, `$MIG` nomeados uma vez.
