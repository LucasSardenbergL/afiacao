# PR-2 — Religamento da demanda de insumos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development para implementar task-por-task. Steps usam checkbox (`- [ ]`).

**Goal:** Religar as 4 views estatísticas de demanda na `v_sku_demanda_efetiva` (PR-1) + corrigir o furo #10 (devolução), fazendo os 23 insumos elegíveis aparecerem no cockpit quando o estoque cai ao ponto — sem mudar a classe de nenhum produto vendido.

**Architecture:** Trocar `FROM v_venda_items_history_efetivo venda_items_history` → `FROM v_sku_demanda_efetiva venda_items_history` nas 4 views (alias preservado → referências qualificadas seguem válidas; zero mudança de agregação/colunas). Como `v_sku_demanda_efetiva = v_venda_items_history_efetivo ⊕ consumo`, o produto vendido enxerga a MESMA demanda (só venda); o insumo ganha o consumo. `v_sku_classificacao_abc_xyz`, `v_sku_parametros_sugeridos` e o motor **herdam sem tocar**.

**Tech Stack:** PostgreSQL (Supabase prod). Views SQL. Harness PG17 (`db/test-*.sh`). Apply manual no SQL Editor do Lovable.

**Spec:** `docs/superpowers/specs/2026-07-11-reposicao-pr2-religamento-criticidade-design.md`

## Global Constraints

- **MONEY-PATH PLENO.** Muda comportamento de compra. Nada em prod sem: PG17 com falsificação + Codex challenge do SQL + **prova de performance sob `SET ROLE authenticated`** + verificação pós-apply.
- **Pré-requisito de apply:** PR-1 já aplicado em prod (verificado: `v_sku_demanda_efetiva` existe, 297 pares, 0 duplicatas).
- **NUNCA** editar `supabase/migrations/`. SQL vive em `db/`, colado no SQL Editor.
- `CREATE OR REPLACE VIEW` **DEVE** repetir `WITH (security_invoker = true)` — sem ele o replace **ZERA** o reloptions e a view volta a rodar como owner (bypassa RLS → vaza dado; regressão do P0/#1292). Ver `db/reposicao-consolidacao-demanda.sql:16`.
- **Ordem exata de colunas** preservada em cada view (senão `cannot change name of view column`).
- **A última recriação vence:** as 4 views hoje vêm de `db/reposicao-consolidacao-demanda.sql`. O arquivo do religamento passa a ser a versão canônica dessas 4 — aplicá-lo DEPOIS.
- Idioma pt-BR em código/commits.

## Premissas medidas em prod (2026-07-11 — Task 0 revalida)

| Fato | Valor |
|---|---|
| `v_sku_demanda_efetiva` (PR-1) | aplicada; 23 insumos, 297 pares, 0 duplicatas |
| 4 views a religar leem `FROM v_venda_items_history_efetivo venda_items_history` | linhas 72/108/138/147/189 de `db/reposicao-consolidacao-demanda.sql` |
| `security_invoker=true` nelas (P0/#1292) | a confirmar no pré-flight (reloptions) |
| BASE: demanda explodida | consumo 0,61/dia + venda direta 0,15/dia = 0,76/dia total |

## File Structure

- **Create:** `db/reposicao-religamento-insumos.sql` — recria as 4 views com `FROM v_sku_demanda_efetiva` (fonte viva). Uma responsabilidade: apontar a demanda para a fonte explodida.
- **Modify:** `db/reposicao-demanda-insumos-bom.sql` — fix #10 na `v_sku_demanda_efetiva` (1 linha).
- **Create:** `db/test-reposicao-religamento.sh` — harness PG17 (PR-1 + fix#10 + religamento).
- **Create:** `db/preflight-reposicao-religamento.sql` — capturas read-only (Task 0).
- **Modify:** nenhuma view existente além das 4 religadas + v_sku_demanda_efetiva.

---

### Task 0: Pré-flight — congelar o estado real da prod

**Files:** Create `db/preflight-reposicao-religamento.sql`

**Interfaces:** Produces os fatos que Task 2/3 assumem. Divergiu → parar e reavaliar.

- [ ] **Step 1: Escrever o pré-flight**

```sql
-- db/preflight-reposicao-religamento.sql — READ-ONLY, rodar via psql-ro.
-- P1: as 4 views leem v_venda_items_history_efetivo hoje? (o FROM a trocar)
SELECT 'P1_'||c.relname AS chk,
       (SELECT count(*) FROM regexp_matches(pg_get_viewdef(c.oid,true),'v_venda_items_history_efetivo','g'))::text AS from_hits,
       c.reloptions::text AS reloptions   -- esperado: {security_invoker=true}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
ORDER BY c.relname;

-- P2: a def prod das 4 bate com db/reposicao-consolidacao-demanda.sql? (md5 p/ detectar drift)
SELECT 'P2_'||c.relname AS chk, md5(pg_get_viewdef(c.oid,true)) AS md5_prod
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
ORDER BY c.relname;

-- P3: v_sku_demanda_efetiva existe (PR-1 aplicado)?
SELECT 'P3_demanda_efetiva' AS chk, count(*)::text FROM pg_views WHERE viewname='v_sku_demanda_efetiva';  -- esperado 1

-- P4: v_sku_parametros_sugeridos lê as 4 (herança) — confirmar que NÃO referencia v_sku_demanda_efetiva ainda
SELECT 'P4_sugeridos_ja_le_efetiva' AS chk,
       (SELECT count(*) FROM regexp_matches(pg_get_viewdef('v_sku_parametros_sugeridos',true),'v_sku_demanda_efetiva','g'))::text;  -- esperado 0
```

- [ ] **Step 2: Rodar contra prod**

```bash
~/.config/afiacao/psql-ro -f db/preflight-reposicao-religamento.sql
```
Esperado: P1 `from_hits≥1` + `{security_invoker=true}` nas 4; P3=1; P4=0. **Guardar os 4 md5 (P2)** — a Task 2 deve partir da def prod EXATA (se um md5 divergir do repo, capturar a def prod via `pg_get_viewdef` e usar ELA como base, não o arquivo).

- [ ] **Step 3: Confirmar a branch tem o #1292 e commit**

```bash
git merge-base --is-ancestor 64fe7b9b HEAD && echo "ok #1292" || git rebase origin/main
git add db/preflight-reposicao-religamento.sql
git commit -m "chore(reposicao): pre-flight do religamento (PR-2)"
```

---

### Task 1: Fix #10 — devolução não vira consumo negativo

**Files:** Modify `db/reposicao-demanda-insumos-bom.sql` (a view `v_sku_demanda_efetiva`)

**Interfaces:** Consumes `v_pcp_malha_oben`. Produces `v_sku_demanda_efetiva` com o ramo de consumo filtrado a `quantidade>0`.

- [ ] **Step 1: Aplicar o guard** — no ramo de consumo (2ª metade do `UNION ALL`), o `WHERE v.empresa = 'OBEN'` vira:

```sql
WHERE v.empresa = 'OBEN'
  AND v.quantidade > 0;   -- [Codex #10] devolução de tingidor não recompõe componente
```
A 1ª metade (venda direta) permanece intacta (devolução é demanda de venda legítima).

- [ ] **Step 2: `grep` de sanidade**

```bash
grep -c "AND v.quantidade > 0" db/reposicao-demanda-insumos-bom.sql   # esperado 1
```

- [ ] **Step 3: Commit**

```bash
git add db/reposicao-demanda-insumos-bom.sql
git commit -m "fix(reposicao): devolucao nao vira consumo negativo do insumo (#10)"
```

---

### Task 2: Religar as 4 views (`FROM v_sku_demanda_efetiva`)

**Files:** Create `db/reposicao-religamento-insumos.sql`

**Interfaces:** Consumes as defs prod das 4 views (Task 0) + `v_sku_demanda_efetiva`. Produces as 4 views lendo a fonte explodida, shape idêntico.

- [ ] **Step 1: Gerar o arquivo por transformação determinística**

Para cada uma das 4 views, partir da def **prod** (Task 0; se o md5 bate com `db/reposicao-consolidacao-demanda.sql`, usar o arquivo), aplicar EXATAMENTE uma substituição e **nada mais**:

```
FROM v_venda_items_history_efetivo venda_items_history  →  FROM v_sku_demanda_efetiva venda_items_history
FROM v_venda_items_history_efetivo vih                  →  FROM v_sku_demanda_efetiva vih
```
(o alias `venda_items_history`/`vih` é preservado → todas as referências qualificadas seguem válidas). Cada view mantém `WITH (security_invoker = true)` e a ordem de colunas. Cabeçalho do arquivo:

```sql
-- db/reposicao-religamento-insumos.sql — PR-2 (money-path).
-- Religa as 4 views estatísticas na v_sku_demanda_efetiva (venda ⊕ consumo de insumo).
-- Único delta vs db/reposicao-consolidacao-demanda.sql: FROM v_venda_items_history_efetivo
-- → FROM v_sku_demanda_efetiva. security_invoker=true OBRIGATÓRIO em cada CREATE OR REPLACE.
-- É a versão CANÔNICA destas 4 views (aplicar DEPOIS da consolidação). NÃO vai em supabase/migrations/.
```

- [ ] **Step 2: Sanidade estrutural**

```bash
grep -c "CREATE OR REPLACE VIEW" db/reposicao-religamento-insumos.sql          # 4
grep -c "security_invoker = true" db/reposicao-religamento-insumos.sql          # 4
grep -c "FROM v_sku_demanda_efetiva" db/reposicao-religamento-insumos.sql       # ≥4
grep -c "v_venda_items_history_efetivo" db/reposicao-religamento-insumos.sql    # 0 (todas trocadas)
```

- [ ] **Step 3: Commit**

```bash
git add db/reposicao-religamento-insumos.sql
git commit -m "feat(reposicao): religa as 4 views de demanda na v_sku_demanda_efetiva (PR-2)"
```

---

### Task 3: Harness PG17 — prova (PR-1 + fix#10 + religamento)

**Files:** Create `db/test-reposicao-religamento.sh`

**Interfaces:** exit 0 = verde. Aplica, na ordem: snapshot → 3 deps do PCP → `db/reposicao-demanda-insumos-bom.sql` (com fix #10) → `db/reposicao-religamento-insumos.sql`.

**Base:** bootstrap de `db/test-reposicao-demanda-insumos-bom.sh` (initdb, snapshot, deps, `set_malha`). **PORT=5444** (paralelo). Capturar `base_<view>` das 4 views ANTES do religamento (para o EXCEPT ALL de não-regressão).

- [ ] **Step 1: Asserts (money-path)**

```bash
# fixtures: pai 200 vende (ficha 0.9L do insumo 201); produto 300 vende, SEM ficha (não-insumo)
echo "→ A. RELIGAMENTO: o insumo ganha demanda_total_90d > 0"
got=$(Pq -c "SELECT COALESCE(demanda_total_90d,0)>0 FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")
assert_eq "A1 insumo tem demanda apos religar" "t" "$got"

echo "→ B. NÃO-REGRESSÃO: SKU não-insumo (300) idêntico antes/depois nas 4 views"
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  got=$(Pq -c "SELECT count(*) FROM (
                 (SELECT * FROM ${v} WHERE sku_codigo_omie::text='300' EXCEPT ALL SELECT * FROM base_${v} WHERE sku_codigo_omie::text='300')
                 UNION ALL
                 (SELECT * FROM base_${v} WHERE sku_codigo_omie::text='300' EXCEPT ALL SELECT * FROM ${v} WHERE sku_codigo_omie::text='300')) d;")
  assert_eq "B:${v} nao-insumo intacto" "0" "$got"
done

echo "→ C. FIX #10: devolução do pai (qtde<0) NÃO gera consumo negativo"
# semear venda do pai 200 com quantidade=-5 (devolução)
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201 AND quantidade<0;")
assert_eq "C1 sem consumo negativo" "0" "$got"

echo "→ D. GRADUAÇÃO: o insumo sai de AGUARDANDO_SEGUNDA_ORDEM (o problema original era num_ordens=1)"
# fixture: pai 200 vende em DUAS NFs distintas ('NFE-1','NFE-2') → o consumo do insumo 201
# herda as 2 NFs (PR-1) → num_ordens=2. Sem o religamento, o insumo tinha num_ordens=0.
got=$(Pq -c "SELECT num_ordens FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")
assert_eq "D1 insumo graduou: num_ordens=2 (herdou 2 NFs dos pais)" "2" "$got"
# e o gate do motor (ponto_pedido IS NOT NULL) já foi provado no PR-1; a inclusão no cockpit
# é verificada end-to-end na PROD pós-apply (Task 5), com o motor real e os dados reais.

echo "→ E. security_invoker + shape das 4 views preservados"
got=$(Pq -c "SELECT count(*) FROM pg_class WHERE relname IN
      ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
      AND reloptions @> ARRAY['security_invoker=true'];")
assert_eq "E1 4 views security_invoker" "4" "$got"
```

- [ ] **Step 2: FALSIFICAÇÃO**

```bash
echo "→ SAB1: religar SEM o guard #10 → consumo negativo VAZA (C1 quebraria)"
# recriar v_sku_demanda_efetiva sem 'AND v.quantidade>0' → assertar que aparece consumo<0 → prova que C1 protege
echo "→ SAB2: recriar uma view religada SEM security_invoker → E1 cai p/ 3 (prova que E1 protege a RLS)"
```

- [ ] **Step 3: Rodar verde + commit**

```bash
heavy bash db/test-reposicao-religamento.sh > /tmp/relig.log 2>&1; echo $?
git add db/test-reposicao-religamento.sh
git commit -m "test(reposicao): PG17 prova religamento (demanda+graduacao+nao-regressao+fix10+RLS)"
```

---

### Task 4: Prova de performance (o furo #14 — obrigatória)

**Files:** Create `db/perf-reposicao-religamento.sql` (EXPLAIN sob authenticated)

**Interfaces:** decide se o religamento vai a prod direto ou precisa materializar.

- [ ] **Step 1: Medir sob o role real**

```sql
-- rodar via psql-ro MAS com SET ROLE authenticated + GUC do JWT + statement_timeout='8s'.
-- psql-ro tem BYPASSRLS → NÃO reproduz o custo real; por isso o SET ROLE.
SET statement_timeout='8s';
SET ROLE authenticated;  -- + set_config dos claims do JWT (empresa/uid) como o PostgREST faz
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_sku_parametros_sugeridos WHERE empresa='OBEN';
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_sku_candidatos_primeira_compra WHERE empresa='OBEN';
RESET ROLE;
```

- [ ] **Step 2: Veredito**
  - p95 < 4s e sem `statement timeout` → ✅ segue para apply.
  - estourou → **materializar antes do fan-out**: fato privado `empresa×sku×data×NF` com `qtde_direta`/`qtde_consumo` separadas + índice `(empresa,sku,data)`; religar as 4 na materialização. **Escalar ao controlador** — isso vira uma sub-fase de design (não improvisar no plano).

- [ ] **Step 3: Registrar o EXPLAIN** em `db/perf-reposicao-religamento.sql` + commit.

---

### Task 5: Codex do SQL + handoff de apply

**Files:** Create `docs/handoff/2026-07-11-pr2-apply.md`

- [ ] **Step 1: Codex challenge (money-path)** — `cat db/reposicao-religamento-insumos.sql db/reposicao-demanda-insumos-bom.sql | scripts/codex-async.sh -r xhigh -` (background). Pedir: dupla contagem venda+consumo, não-regressão real, ordem das colunas, RLS, performance.

- [ ] **Step 2: Handoff de apply** — bloco pro SQL Editor (ordem: `reposicao-demanda-insumos-bom.sql` re-aplicado com fix#10, DEPOIS `reposicao-religamento-insumos.sql`) + validação pós-apply:

```sql
-- esperado: insumo com demanda; TINGIMIX sugerível; produto com classe idêntica
SELECT 'base_demanda' AS chk, round(demanda_media_diaria,2)::text FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=8689961993 AND empresa='OBEN'
UNION ALL SELECT 'base_ponto_pedido', ponto_pedido::text FROM sku_parametros WHERE sku_codigo_omie::bigint=8689961993 AND empresa='OBEN';
```

- [ ] **Step 3: Verificação pós-apply (psql-ro)** + PR draft (NÃO criar sem ok do founder — CLAUDE.md).

## Self-Review

**Spec coverage:** §4.1 religamento → Task 2. §4.2 fix#10 → Task 1. §5 não-regressão → Task 3 B. §5 performance #14 → Task 4. §6 provas → Task 3. §7 furos: #10 corrigido (Task 1/3C); #9/#11/#13 são limitações declaradas no spec (não código); demais furos eliminados por não haver V3.

**Placeholders:** asserts A–E têm bash executável. SAB1/SAB2 (falsificação) descrevem a sabotagem em 1 linha — o implementador recria a view sem o guard seguindo o padrão de sabotagem do PR-1 (`db/test-reposicao-demanda-insumos-bom.sh` S1–S3). O teste-fim do motor (insumo sugerido) foi **movido para a verificação pós-apply na PROD** (Task 5) — no harness prova-se a graduação (`num_ordens=2`), e o gate do motor já foi provado no PR-1; reproduzir o motor inteiro no harness seria duplicar `db/test-embalagem-motor.sh` sem ganho.

**Type consistency:** as 4 views mantêm shape (o religamento não muda colunas). `v_sku_demanda_efetiva` shape idêntico a `v_venda_items_history_efetivo` (garantido pelo PR-1, assert R1). Alias `venda_items_history`/`vih` preservado.

**Gap conhecido:** Task 4 pode escalar para materialização (design próprio) se o EXPLAIN estourar — sinalizado, não silenciado.
