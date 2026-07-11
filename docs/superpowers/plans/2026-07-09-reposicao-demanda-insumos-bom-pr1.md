# PR-1 — Fonte de demanda de insumos (explosão de BOM) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar as duas views que derivam a demanda de insumos de produção a partir da ficha técnica (malha do Omie), **sem alterar comportamento algum** — as 4 views estatísticas seguem lendo a fonte antiga. Entrega verificável e reversível.

**Architecture:** `vw_pcp_malha_componentes` (ficha, código Colacor) → `v_pcp_malha_oben` (tradução para OBEN, guards fail-closed) → `v_sku_demanda_efetiva` (vendas diretas ⊕ consumo explodido). Nada consome `v_sku_demanda_efetiva` ainda: o religamento é o PR-2.

**Tech Stack:** PostgreSQL 17 (Supabase prod), views SQL puras. Prova local via harness PG17 (`db/test-*.sh`) que carrega o `schema-snapshot.sql` real. Apply manual no SQL Editor do Lovable.

**Spec:** `docs/superpowers/specs/2026-07-09-reposicao-demanda-insumos-producao-bom-design.md`

## Global Constraints

- **MONEY-PATH.** Dirige compra. Nada vai a prod sem: prova PG17 **com falsificação** + Codex challenge sobre o SQL + verificação read-only pós-apply (`~/.config/afiacao/psql-ro`).
- **NUNCA** editar `supabase/migrations/` (o snapshot é a fonte de DR). O SQL vive em `db/reposicao-demanda-insumos-bom.sql` (fonte viva) e é colado no **SQL Editor do Lovable** pelo founder.
- Todo objeto é `CREATE OR REPLACE` **idempotente** (recolar é rotina).
- `ausente ≠ zero`: linha de consumo tem `valor_unitario`/`valor_total` **NULL**. Nunca 0.
- **Ambiguidade nunca é silenciada:** o que não passa nos guards vai para `v_pcp_malha_oben_quarentena` com `motivo`, jamais some.
- **Nunca `LIMIT 1`** para resolver cardinalidade ambígua.
- PL/pgSQL é late-bound — provar **EXECUTANDO**, não só criando.
- Idioma: pt-BR em código, commits e comentários.

## Premissas medidas em prod (2026-07-09, `psql-ro`) — o Task 0 revalida

| Fato | Valor |
|---|---|
| `vw_pcp_malha_componentes` | 6.732 linhas = 6.732 pares distintos (0 duplicata) |
| `perc_perda <> 0` | 3 linhas, **0** no escopo OBEN ativo |
| `codigo` duplicado por conta (componentes) | **0** |
| Auto-referência `pai = componente` | **0** |
| Insumos ativos OBEN com ficha | 58 → **25** unidade compatível → **23** elegíveis (invisíveis) |
| Unidade divergente | **33** (quarentena) |
| De-para de consolidação ∩ malha | **1** (`DILUENTE PU DFA.4128LT` como **PAI**) |
| `md5(text)::uuid` | funciona (id determinístico da linha sintética) |

## File Structure

- **Create:** `db/reposicao-demanda-insumos-bom.sql` — fonte viva do SQL (3 views + comentários). Uma responsabilidade: derivar demanda de insumo a partir da ficha.
- **Create:** `db/test-reposicao-demanda-insumos-bom.sh` — harness PG17, asserts positivos/negativos + falsificação.
- **Create:** `db/preflight-reposicao-demanda-insumos.sql` — capturas read-only do estado da prod (Task 0).
- **Modify:** nenhum arquivo existente. **Nenhuma view existente é recriada neste PR** (é o que o torna inerte).

---

### Task 0: Pré-flight — congelar o estado real da prod

**Files:**
- Create: `db/preflight-reposicao-demanda-insumos.sql`

**Interfaces:**
- Consumes: nada.
- Produces: os fatos que o harness e o Task 1 assumem. Se algum divergir, **parar** e reavaliar o spec.

- [ ] **Step 1: Escrever as queries de pré-flight**

```sql
-- db/preflight-reposicao-demanda-insumos.sql
-- READ-ONLY. Rodar via ~/.config/afiacao/psql-ro. Congela as premissas do PR-1.

-- P1: a malha não tem par duplicado (senão a regra de dedup muda de inerte p/ ativa)
SELECT 'P1_pares_duplicados' AS chk,
       count(*) AS valor  -- esperado: 0
FROM (SELECT pai_codigo, componente_codigo FROM vw_pcp_malha_componentes
      GROUP BY 1,2 HAVING count(*) > 1) t;

-- P2: perc_perda fora do escopo OBEN ativo
SELECT 'P2_perc_perda_no_escopo_oben' AS chk, count(*) AS valor  -- esperado: 0
FROM vw_pcp_malha_componentes m
JOIN omie_products opc ON opc.omie_codigo_produto=m.componente_codigo AND opc.account='colacor'
JOIN omie_products opb ON opb.codigo=opc.codigo AND opb.account='oben' AND opb.ativo
WHERE COALESCE(m.perc_perda,0) <> 0;

-- P3: codigo ambíguo (>1 linha ativa) na conta oben, entre os codigos da malha
SELECT 'P3_codigo_ambiguo_oben' AS chk, count(*) AS valor  -- esperado: 0
FROM (
  SELECT op.codigo FROM omie_products op
  WHERE op.account='oben' AND op.ativo AND op.codigo IN (
    SELECT c.codigo FROM omie_products c
    WHERE c.account='colacor' AND c.omie_codigo_produto IN (
      SELECT componente_codigo FROM vw_pcp_malha_componentes
      UNION SELECT pai_codigo FROM vw_pcp_malha_componentes))
  GROUP BY op.codigo HAVING count(*) > 1
) t;

-- P4: auto-referência
SELECT 'P4_auto_referencia' AS chk, count(*) AS valor  -- esperado: 0
FROM vw_pcp_malha_componentes WHERE pai_codigo = componente_codigo;

-- P5: interseção malha × de-para de consolidação (esperado: 1, como PAI)
SELECT 'P5_intersecao_depara' AS chk, count(*) AS valor
FROM sku_substituicao s
WHERE s.status='aplicada' AND s.acao_parametros='consolidar_demanda';

-- P6: baseline do BASE — demanda explodida esperada (~0.5776 L/dia)
WITH receita AS (
  SELECT m.pai_codigo, m.quantidade AS qtde_base
  FROM vw_pcp_malha_componentes m WHERE m.componente_codigo = 394035943
),
pai_oben AS (
  SELECT r.qtde_base, opb.omie_codigo_produto AS pai
  FROM receita r
  JOIN omie_products opc ON opc.omie_codigo_produto=r.pai_codigo AND opc.account='colacor'
  JOIN omie_products opb ON opb.codigo=opc.codigo AND opb.account='oben'
)
SELECT 'P6_demanda_explodida_base_dia' AS chk,
       round(sum(COALESCE(sp.demanda_media_diaria,0) * po.qtde_base)::numeric, 4) AS valor
FROM pai_oben po
LEFT JOIN sku_parametros sp ON sp.sku_codigo_omie::bigint = po.pai AND sp.empresa='OBEN';

-- P7: nada depende ainda de v_sku_demanda_efetiva (deve não existir)
SELECT 'P7_view_ja_existe' AS chk,
       count(*) AS valor  -- esperado: 0
FROM pg_class WHERE relname = 'v_sku_demanda_efetiva';

-- P8: viewdef verbatim das 4 views estatísticas (baseline p/ o EXCEPT ALL do Task 4)
SELECT 'P8_viewdef' AS chk, c.relname,
       md5(pg_get_viewdef(c.oid, true)) AS md5_viewdef
FROM pg_class c
WHERE c.relname IN ('v_sku_demanda_estatisticas','v_sku_sigma_demanda',
                    'v_sku_demanda_rajada','v_sku_candidatos_primeira_compra',
                    'v_venda_items_history_efetivo')
ORDER BY c.relname;
```

- [ ] **Step 2: Rodar o pré-flight contra a prod**

```bash
~/.config/afiacao/psql-ro -f db/preflight-reposicao-demanda-insumos.sql
```

Esperado: `P1=0`, `P2=0`, `P3=0`, `P4=0`, `P5=2` (2 mapas, 1 tocando a malha), `P6≈0.5776`, `P7=0`, e 5 md5 de viewdef.

**Se P1/P3/P4 > 0:** os guards deixam de ser inertes — a quarentena vai capturar linhas reais. Não é bloqueio, mas **anote os números** (o Task 5 valida contra eles).

- [ ] **Step 3: Commit**

```bash
git add db/preflight-reposicao-demanda-insumos.sql
git commit -m "chore(reposicao): pre-flight read-only das premissas do PR-1 (BOM insumos)"
```

---

### Task 1: `v_pcp_malha_oben` — tradução de conta com guards fail-closed

**Files:**
- Create: `db/reposicao-demanda-insumos-bom.sql`

**Interfaces:**
- Consumes: `vw_pcp_malha_componentes(pai_codigo, componente_codigo, quantidade, unidade, perc_perda)`, `omie_products(omie_codigo_produto, codigo, account, ativo, unidade)`, `sku_substituicao`.
- Produces (o Task 3 depende **exatamente** destes nomes):
  - `v_pcp_malha_oben(pai_oben bigint, comp_oben bigint, quantidade numeric, unidade text)` — 1 linha por par, só pares **inequívocos**.
  - `v_pcp_malha_oben_quarentena(..., motivo text)` — tudo que foi excluído, com o porquê.
  - `v_pcp_malha_oben_cand(...)` — intermediária (tradução crua + cardinalidade), base das duas acima.

- [ ] **Step 1: Escrever o SQL das 3 views**

```sql
-- db/reposicao-demanda-insumos-bom.sql
-- ============================================================================
-- Demanda de INSUMOS DE PRODUÇÃO via explosão de BOM (money-path).
-- PR-1: só cria as views-fonte. NÃO religa nada → inerte por construção.
-- Spec: docs/superpowers/specs/2026-07-09-reposicao-demanda-insumos-producao-bom-design.md
-- NÃO vai em supabase/migrations/. Colar no SQL Editor do Lovable → Run.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CANDIDATOS: tradução crua ficha(Colacor) → OBEN + cardinalidade + unidades.
--    Não filtra nada; é a base tanto do elegível quanto da quarentena.
--    O de-para de consolidação (N→1) é aplicado ao pai E ao componente, para
--    casar com o espaço de SKU de v_venda_items_history_efetivo (Codex #7:
--    hoje o DILUENTE PU DFA.4128LT é PAI na malha e está consolidado).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_pcp_malha_oben_cand AS
WITH oben_ativo AS (
  -- 1 linha por codigo. `n` expõe a ambiguidade em vez de escondê-la (nunca LIMIT 1).
  SELECT codigo,
         count(*)                 AS n,
         min(omie_codigo_produto) AS omie
  FROM omie_products
  WHERE account = 'oben' AND ativo AND codigo IS NOT NULL AND btrim(codigo) <> ''
  GROUP BY codigo
),
col AS (
  SELECT omie_codigo_produto, codigo
  FROM omie_products
  WHERE account = 'colacor' AND codigo IS NOT NULL AND btrim(codigo) <> ''
),
efetivo AS (
  -- MESMO predicado de v_venda_items_history_efetivo (isola dos mapas da feature antiga)
  SELECT sku_codigo_antigo::bigint AS antigo, sku_codigo_novo::bigint AS novo
  FROM sku_substituicao
  WHERE empresa = 'OBEN' AND status = 'aplicada'
    AND acao_parametros = 'consolidar_demanda'
    AND sku_codigo_novo ~ '^\d+$' AND sku_codigo_antigo ~ '^\d+$'
)
SELECT
  m.pai_codigo,
  m.componente_codigo,
  m.quantidade,
  m.unidade                               AS un_ficha,
  COALESCE(m.perc_perda, 0)               AS perc_perda,
  pob.n                                   AS n_pai_oben,
  cob.n                                   AS n_comp_oben,
  COALESCE(ep.novo, pob.omie)             AS pai_oben,   -- espaço EFETIVO
  COALESCE(ec.novo, cob.omie)             AS comp_oben,  -- espaço EFETIVO
  cfin.unidade                            AS un_estoque, -- unidade do insumo FINAL
  cfin.ativo                              AS comp_ativo
FROM vw_pcp_malha_componentes m
JOIN col pcol ON pcol.omie_codigo_produto = m.pai_codigo
JOIN col ccol ON ccol.omie_codigo_produto = m.componente_codigo
LEFT JOIN oben_ativo pob ON pob.codigo = pcol.codigo
LEFT JOIN oben_ativo cob ON cob.codigo = ccol.codigo
LEFT JOIN efetivo    ep  ON ep.antigo   = pob.omie
LEFT JOIN efetivo    ec  ON ec.antigo   = cob.omie
LEFT JOIN omie_products cfin
       ON cfin.omie_codigo_produto = COALESCE(ec.novo, cob.omie)
      AND cfin.account = 'oben';

COMMENT ON VIEW v_pcp_malha_oben_cand IS
  'Tradução crua da ficha técnica (malha Omie, cód. Colacor) para o espaço de SKU OBEN efetivo. Não filtra: expõe cardinalidade (n_pai_oben/n_comp_oben) e unidades para os guards. Base de v_pcp_malha_oben e _quarentena.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ELEGÍVEL: só o par inequívoco. Todo guard é fail-closed.
--    HAVING count(DISTINCT quantidade)=1 → duplicata exata deduplica;
--    par com qtdes divergentes NÃO passa (cai na quarentena). Codex #2.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_pcp_malha_oben AS
SELECT
  c.pai_oben,
  c.comp_oben,
  min(c.quantidade) AS quantidade,   -- seguro: HAVING garante que todas são iguais
  min(c.un_ficha)   AS unidade
FROM v_pcp_malha_oben_cand c
WHERE c.n_pai_oben = 1                       -- 0 = sumiu; >1 = ambíguo → quarentena
  AND c.n_comp_oben = 1
  AND c.pai_oben IS NOT NULL
  AND c.comp_oben IS NOT NULL
  AND c.pai_oben <> c.comp_oben              -- auto-referência dobraria a demanda
  AND c.quantidade > 0
  AND c.perc_perda = 0                       -- não aplicar fator de perda silencioso
  AND c.un_ficha = c.un_estoque              -- unidade errada = compra errada
  AND c.comp_ativo
GROUP BY c.pai_oben, c.comp_oben
HAVING count(DISTINCT c.quantidade) = 1;

COMMENT ON VIEW v_pcp_malha_oben IS
  'Ficha técnica traduzida p/ OBEN, apenas pares inequívocos (cardinalidade 1:1, unidade da ficha = unidade de estoque, sem perda, sem auto-referência, qtde consistente). O excluído vive em v_pcp_malha_oben_quarentena com motivo.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. QUARENTENA: nada some calado. Um motivo por linha excluída.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_pcp_malha_oben_quarentena AS
WITH classif AS (
  SELECT c.*,
    CASE
      WHEN c.n_pai_oben IS NULL OR c.n_pai_oben = 0   THEN 'pai_sem_par_oben_ativo'
      WHEN c.n_pai_oben > 1                           THEN 'pai_ambiguo_oben'
      WHEN c.n_comp_oben IS NULL OR c.n_comp_oben = 0 THEN 'componente_sem_par_oben_ativo'
      WHEN c.n_comp_oben > 1                          THEN 'componente_ambiguo_oben'
      WHEN NOT COALESCE(c.comp_ativo, false)          THEN 'componente_inativo_oben'
      WHEN c.pai_oben = c.comp_oben                   THEN 'auto_referencia'
      WHEN c.quantidade IS NULL OR c.quantidade <= 0  THEN 'quantidade_invalida'
      WHEN c.perc_perda <> 0                          THEN 'perc_perda_nao_suportada'
      WHEN c.un_ficha IS DISTINCT FROM c.un_estoque   THEN 'unidade_divergente'
      ELSE NULL
    END AS motivo
  FROM v_pcp_malha_oben_cand c
)
SELECT pai_codigo, componente_codigo, pai_oben, comp_oben,
       quantidade, un_ficha, un_estoque, perc_perda, motivo
FROM classif WHERE motivo IS NOT NULL
UNION ALL
-- par que passou em tudo, mas tem quantidades divergentes entre linhas
SELECT c.pai_codigo, c.componente_codigo, c.pai_oben, c.comp_oben,
       c.quantidade, c.un_ficha, c.un_estoque, c.perc_perda,
       'quantidade_divergente_no_par'::text
FROM classif c
WHERE c.motivo IS NULL
  AND (c.pai_oben, c.comp_oben) IN (
        SELECT pai_oben, comp_oben FROM classif
        WHERE motivo IS NULL
        GROUP BY 1,2 HAVING count(DISTINCT quantidade) > 1);

COMMENT ON VIEW v_pcp_malha_oben_quarentena IS
  'Pares da ficha EXCLUÍDOS da explosão, com motivo. Fila de exceção: precisão>recall — insumo com unidade divergente ou cardinalidade ambígua não vira compra, mas fica visível aqui.';
```

- [ ] **Step 2: Verificar sintaticamente (sem aplicar em prod)**

Aplicar num PG17 local descartável já é o Task 2. Aqui, só conferir que o arquivo não tem erro óbvio de digitação:

```bash
grep -c "CREATE OR REPLACE VIEW" db/reposicao-demanda-insumos-bom.sql
```
Expected: `3`

- [ ] **Step 3: Commit**

```bash
git add db/reposicao-demanda-insumos-bom.sql
git commit -m "feat(reposicao): v_pcp_malha_oben — ficha traduzida p/ OBEN com guards fail-closed"
```

---

### Task 2: Harness PG17 — provar `v_pcp_malha_oben` com falsificação

**Files:**
- Create: `db/test-reposicao-demanda-insumos-bom.sh`

**Interfaces:**
- Consumes: `db/reposicao-demanda-insumos-bom.sql`, `supabase/schema-snapshot.sql`, `db/stubs-supabase.sql`.
- Produces: exit 0 = verde. Um `PASS=N` no fim.

**Base:** copiar o bootstrap de `db/test-reposicao-consolidacao-demanda.sh` (initdb, snapshot, stubs). Usar `PORT=5443` (≠ 5442) para rodar em paralelo.

⚠️ **Ordem de dependências (verificada no pré-voo — NÃO improvisar).** O `schema-snapshot.sql` **não contém** `pcp_malha_staging`, `vw_pcp_malha_itens`, `vw_pcp_malha_componentes` nem `v_venda_items_history_efetivo` (o PCP e a consolidação foram aplicados depois do dump). Aplicar nesta ordem, **após** o snapshot:

```bash
echo "→ dependências (o snapshot não as tem)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/pcp-f1a-m1-staging.sql"        # pcp_malha_staging
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"         # fn_pcp_num + vw_pcp_malha_itens/_componentes
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-consolidacao-demanda.sql"  # v_venda_items_history_efetivo + redirects

# baseline das 4 views ANTES do candidato (Task 4 usa isto)
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  P -v ON_ERROR_STOP=1 -q -c "CREATE TABLE base_${v} AS SELECT * FROM ${v};"
done

echo "→ aplicando a migração candidata…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"
```

- [ ] **Step 1: Bootstrap, helpers e fixtures**

```bash
PASS=0
Pq() { P -tA -q "$@"; }
assert_eq() { # $1=nome $2=esperado $3=obtido
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else echo "  ✗ $1: esperado='$2' obtido='$3'"; exit 1; fi
}

# A malha NÃO é tabela: vw_pcp_malha_componentes → vw_pcp_malha_itens → pcp_malha_staging(payload jsonb).
# Semear = UPSERT do payload do pai. $1=pai_omie  $2=json array de itens
set_malha() {
  P -v ON_ERROR_STOP=1 -q -c "
    INSERT INTO pcp_malha_staging (omie_codigo_produto, empresa, payload, sync_run_id, synced_at)
    VALUES ($1, 'colacor',
            jsonb_build_object('ident', jsonb_build_object('idProduto', $1), 'itens', '$2'::jsonb),
            1, now())
    ON CONFLICT (omie_codigo_produto) DO UPDATE SET payload = EXCLUDED.payload;"
}
# item padrão: {"idProdMalha":<comp>,"quantProdMalha":<q>,"unidProdMalha":"<un>","percPerdaProdMalha":<p>}

echo "→ semeando catálogo (2 contas por codigo — é assim que Colacor↔OBEN se ligam)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
VALUES (gen_random_uuid(), 100, 'PRD_PAI',  'TINGIDOR X', 'colacor', true, 'UN'),
       (gen_random_uuid(), 200, 'PRD_PAI',  'TINGIDOR X', 'oben',    true, 'UN'),
       (gen_random_uuid(), 101, 'PRD_BASE', 'BASE',       'colacor', true, 'L'),
       (gen_random_uuid(), 201, 'PRD_BASE', 'BASE',       'oben',    true, 'L'),
       -- unidade divergente: ficha diz M2, estoque do insumo é UN
       (gen_random_uuid(), 102, 'PRD_DISC', 'DISCO',      'colacor', true, 'M2'),
       (gen_random_uuid(), 202, 'PRD_DISC', 'DISCO',      'oben',    true, 'UN');
SQL

echo "→ ficha: pai 100 leva 0.9 L do componente 101, e 1 M2 do componente 102"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
                {"idProdMalha":102,"quantProdMalha":1,"unidProdMalha":"M2","percPerdaProdMalha":0}]'

echo "→ sanidade: a malha real enxerga os 2 pares"
got=$(Pq -c "SELECT count(*) FROM vw_pcp_malha_componentes WHERE pai_codigo=100;")
assert_eq "setup: malha montada a partir do jsonb" "2" "$got"
```

> A view real `vw_pcp_malha_componentes` é exercitada de verdade (não é stub): o fixture entra pelo mesmo caminho do sync do Omie.

- [ ] **Step 2: Asserts positivos**

```bash
echo "→ A. par limpo entra no elegível"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "A1 par limpo elegivel" "1" "$got"

got=$(Pq -c "SELECT quantidade FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "A2 qtde preservada" "0.9" "$got"

echo "→ B. unidade divergente NÃO entra e aparece na quarentena"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE comp_oben=202;")
assert_eq "B1 unidade divergente barrada" "0" "$got"

got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE comp_oben=202;")
assert_eq "B2 motivo diagnosticado" "unidade_divergente" "$got"
```

- [ ] **Step 3: Asserts negativos (cardinalidade, auto-ref, perda)**

```bash
echo "→ C. codigo ambíguo em OBEN → fail-closed (não explode, vai p/ quarentena)"
P -q -c "INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
         VALUES (gen_random_uuid(), 999, 'PRD_BASE', 'BASE CLONE', 'oben', true, 'L');"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE comp_oben IN (201,999);")
assert_eq "C1 ambiguo nao explode (COMPRA DOBRADA evitada)" "0" "$got"
got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE componente_codigo=101 LIMIT 1;")
assert_eq "C2 motivo ambiguo" "componente_ambiguo_oben" "$got"
P -q -c "DELETE FROM omie_products WHERE omie_codigo_produto=999;"

FICHA_OK='[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
           {"idProdMalha":102,"quantProdMalha":1,"unidProdMalha":"M2","percPerdaProdMalha":0}]'

echo "→ D. auto-referência barrada (venda direta + sintética do mesmo SKU = compra dobrada)"
set_malha 100 '[{"idProdMalha":100,"quantProdMalha":1,"unidProdMalha":"UN","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=200;")
assert_eq "D1 auto-referencia barrada" "0" "$got"
got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE pai_codigo=100 AND componente_codigo=100;")
assert_eq "D2 motivo auto_referencia" "auto_referencia" "$got"

echo "→ E. perc_perda <> 0 barrada (não aplicar fator de perda silencioso)"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0.6}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "E1 perc_perda barrada" "0" "$got"
got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE pai_codigo=100 AND componente_codigo=101;")
assert_eq "E2 motivo perc_perda" "perc_perda_nao_suportada" "$got"

echo "→ F. quantidades divergentes no mesmo par → quarentena, NUNCA soma nem escolhe"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
                {"idProdMalha":101,"quantProdMalha":1.5,"unidProdMalha":"L","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "F1 par divergente NAO entra (nem soma 2.4, nem escolhe 0.9)" "0" "$got"
got=$(Pq -c "SELECT DISTINCT motivo FROM v_pcp_malha_oben_quarentena
             WHERE pai_codigo=100 AND componente_codigo=101;")
assert_eq "F2 motivo quantidade_divergente" "quantidade_divergente_no_par" "$got"

echo "→ G. duplicata EXATA deduplica (1 linha, qtde NÃO dobra)"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
                {"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "G1 duplicata exata deduplica" "1" "$got"
got=$(Pq -c "SELECT quantidade FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "G2 qtde NAO dobrou (0.9, nao 1.8)" "0.9" "$got"

echo "→ RES. componente que NÃO resolve no catálogo colacor → quarentena (nada some — Crítico do review)"
# produto colacor 103 existe mas SEM codigo PRD → não traduzível p/ OBEN
P -q -c "INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
         VALUES (gen_random_uuid(), 103, '', 'COMP SEM PRD', 'colacor', true, 'L');"
set_malha 100 '[{"idProdMalha":103,"quantProdMalha":0.5,"unidProdMalha":"L","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200;")
assert_eq "RES1 nao-resolvido NAO entra no elegivel" "0" "$got"
got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE pai_codigo=100 AND componente_codigo=103;")
assert_eq "RES2 nao-resolvido diagnosticado (nada some)" "componente_nao_resolvido_colacor" "$got"
P -q -c "DELETE FROM omie_products WHERE omie_codigo_produto=103;"

echo "→ SEC. as 3 views têm security_invoker (não bypassam a RLS staff-only das bases — Crítico do review)"
got=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.reloptions @> ARRAY['security_invoker=true']
               AND c.relname IN ('v_pcp_malha_oben_cand','v_pcp_malha_oben','v_pcp_malha_oben_quarentena');")
assert_eq "SEC1 as 3 views sao security_invoker" "3" "$got"

# restaurar a ficha boa para os testes seguintes
set_malha 100 "$FICHA_OK"
```

- [ ] **Step 4: FALSIFICAÇÃO (sabotar → exigir vermelho)**

Um assert só vale se ele **falha** quando o guard some. Sabote e exija vermelho:

```bash
echo "→ SABOTAGEM S1: sem o guard de unidade, o par UN|M2 deve VAZAR (B1 quebraria)"
P -q -c "CREATE OR REPLACE VIEW v_pcp_malha_oben AS
         SELECT c.pai_oben, c.comp_oben, min(c.quantidade) AS quantidade, min(c.un_ficha) AS unidade
         FROM v_pcp_malha_oben_cand c
         WHERE c.n_pai_oben=1 AND c.n_comp_oben=1 AND c.pai_oben<>c.comp_oben
           AND c.quantidade>0 AND c.perc_perda=0 AND c.comp_ativo
         GROUP BY 1,2 HAVING count(DISTINCT c.quantidade)=1;"   -- SEM o guard de unidade
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE comp_oben=202;")
if [ "$got" = "0" ]; then
  echo "  ✗ SABOTAGEM S1 INÚTIL: o assert B1 não detecta a remoção do guard de unidade"; exit 1
fi
echo "  ✓ S1 ok (guard removido → par divergente vaza; logo B1 protege de verdade)"
PASS=$((PASS+1))

echo "→ SABOTAGEM S2: trocar o fail-closed de cardinalidade por LIMIT 1 deve produzir COMPRA DOBRADA"
P -q -c "INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
         VALUES (gen_random_uuid(), 998, 'PRD_BASE', 'BASE CLONE', 'oben', true, 'L');"
P -q -c "CREATE OR REPLACE VIEW v_pcp_malha_oben AS
         SELECT c.pai_oben, c.comp_oben, min(c.quantidade) AS quantidade, min(c.un_ficha) AS unidade
         FROM v_pcp_malha_oben_cand c
         WHERE c.pai_oben IS NOT NULL AND c.comp_oben IS NOT NULL   -- SEM n_*_oben = 1
           AND c.pai_oben<>c.comp_oben AND c.quantidade>0 AND c.perc_perda=0
           AND c.un_ficha=c.un_estoque AND c.comp_ativo
         GROUP BY 1,2 HAVING count(DISTINCT c.quantidade)=1;"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE comp_oben IS NOT NULL;")
base=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben_cand WHERE n_comp_oben=1 AND n_pai_oben=1;")
if [ "$got" -le "$base" ]; then
  echo "  ✗ SABOTAGEM S2 INÚTIL: remover o guard de cardinalidade não mudou o resultado"; exit 1
fi
echo "  ✓ S2 ok (sem fail-closed o codigo ambiguo entra → C1 protege de compra dobrada)"
PASS=$((PASS+1))
P -q -c "DELETE FROM omie_products WHERE omie_codigo_produto=998;"

# restaurar a versão real antes de seguir
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"
```

- [ ] **Step 5: Rodar e exigir verde**

```bash
heavy bash db/test-reposicao-demanda-insumos-bom.sh > /tmp/bom-t2.log 2>&1; echo $?
```
Expected: exit `0`, log termina com `PASS=` ≥ 8.

> ⚠️ `| tail` engole o exit code — sempre `> log 2>&1; echo $?`.

- [ ] **Step 6: Commit**

```bash
git add db/test-reposicao-demanda-insumos-bom.sh
git commit -m "test(reposicao): PG17 prova v_pcp_malha_oben (guards + falsificacao)"
```

---

### Task 3: `v_sku_demanda_efetiva` — a explosão

**Files:**
- Modify: `db/reposicao-demanda-insumos-bom.sql` (append)
- Modify: `db/test-reposicao-demanda-insumos-bom.sh` (append asserts)

**Interfaces:**
- Consumes: `v_pcp_malha_oben(pai_oben, comp_oben, quantidade, unidade)` (Task 1), `v_venda_items_history_efetivo` (22 colunas, ordem exata abaixo).
- Produces: `v_sku_demanda_efetiva` com o **mesmo shape** de `v_venda_items_history_efetivo`. O PR-2 vai apontar as 4 views estatísticas para ela.

- [ ] **Step 1: Escrever o teste primeiro (TDD) — a explosão e a NF herdada**

```bash
echo "→ semeando vendas (pai 200 tem ficha 0.9 L do insumo 201; sku 300 não tem ficha)"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
VALUES (gen_random_uuid(), 300, 'PRD_SEMFICHA', 'PRODUTO SEM FICHA', 'oben', true, 'UN');

INSERT INTO venda_items_history
  (id, empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, sku_descricao,
   sku_unidade, quantidade, valor_unitario, valor_total, created_at)
VALUES
  (gen_random_uuid(),'OBEN','NFE-1', CURRENT_DATE - 10, 200, 'TINGIDOR X','UN', 1, 100, 100, now()),
  (gen_random_uuid(),'OBEN','NFE-2', CURRENT_DATE - 5,  200, 'TINGIDOR X','UN', 2, 100, 200, now()),
  (gen_random_uuid(),'OBEN','NFE-3', CURRENT_DATE - 3,  300, 'SEM FICHA','UN',  7, 10,   70, now());
SQL

echo "→ H. explosão: venda de 1 pai (qtde 1) com ficha 0.9 → exatamente 0.9 L do insumo"
got=$(Pq -c "SELECT quantidade FROM v_sku_demanda_efetiva
             WHERE sku_codigo_omie=201 AND nfe_chave_acesso='NFE-1';")
assert_eq "H1 explosao sem fan-out (0.9, nunca 1.8)" "0.9" "$got"

got=$(Pq -c "SELECT quantidade FROM v_sku_demanda_efetiva
             WHERE sku_codigo_omie=201 AND nfe_chave_acesso='NFE-2';")
assert_eq "H2 escala com a qtde do pai (2 x 0.9)" "1.8" "$got"

echo "→ I. NF herdada do pai (Codex #5 — sem isso num_ordens=0 e o insumo NUNCA gradua)"
got=$(Pq -c "SELECT count(DISTINCT nfe_chave_acesso) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
assert_eq "I1 insumo herda 2 NFs distintas (gradua)" "2" "$got"

got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva
             WHERE sku_codigo_omie=201 AND nfe_chave_acesso IS NULL;")
assert_eq "I2 nenhuma linha sintetica sem NF" "0" "$got"

echo "→ J. valor NULL (V3: receita honesta, ausente≠zero)"
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva
             WHERE sku_codigo_omie=201 AND (valor_total IS NOT NULL OR valor_unitario IS NOT NULL);")
assert_eq "J1 sem receita fabricada" "0" "$got"

got=$(Pq -c "SELECT COALESCE(sum(valor_total),0)::text FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
assert_eq "J2 SUM(valor) do insumo = 0 (NULL ignorado, nao fabricado)" "0" "$got"

echo "→ K. unidade do INSUMO, não do pai (Codex #6)"
got=$(Pq -c "SELECT DISTINCT sku_unidade FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
assert_eq "K1 unidade do insumo (L), nao 'UN' do pai" "L" "$got"

echo "→ L. venda direta preservada (passthrough intacto)"
got=$(Pq -c "SELECT quantidade FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=200 AND nfe_chave_acesso='NFE-1';")
assert_eq "L1 venda do pai intacta" "1" "$got"

echo "→ M. pai fora da malha não gera linha sintética"
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=300;")
assert_eq "M1 sku sem ficha: so a venda direta" "1" "$got"

echo "→ N. id da linha sintética é único e determinístico"
got=$(Pq -c "SELECT count(*) - count(DISTINCT id) FROM v_sku_demanda_efetiva;")
assert_eq "N1 nenhum id duplicado" "0" "$got"

echo "→ SEC-DE. v_sku_demanda_efetiva é security_invoker (lê venda_items — dado sensível)"
got=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname='v_sku_demanda_efetiva'
               AND c.reloptions @> ARRAY['security_invoker=true'];")
assert_eq "SEC-DE1 demanda efetiva é security_invoker" "1" "$got"
```

- [ ] **Step 2: Rodar — deve FALHAR (view não existe)**

```bash
heavy bash db/test-reposicao-demanda-insumos-bom.sh > /tmp/bom-t3.log 2>&1; echo $?
```
Expected: exit ≠ 0, com `relation "v_sku_demanda_efetiva" does not exist`.

- [ ] **Step 3: Implementar a view**

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- 4. DEMANDA EFETIVA = vendas diretas ⊕ consumo explodido.
--    Shape IDÊNTICO a v_venda_items_history_efetivo (as 4 views estatísticas do
--    PR-2 esperam este formato — ordem de colunas preservada).
--    NÃO altera v_venda_items_history_efetivo (preço/receita real seguem lá).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_sku_demanda_efetiva WITH (security_invoker = true) AS
SELECT
  id, empresa, nfe_chave_acesso, nfe_numero, nfe_serie, data_emissao,
  cliente_codigo_omie, cliente_razao_social, cliente_cnpj_cpf, cliente_uf, cliente_cidade,
  sku_codigo_omie, sku_codigo, sku_descricao, sku_ncm, sku_unidade,
  quantidade, valor_unitario, valor_total, cfop, raw_data, created_at
FROM v_venda_items_history_efetivo

UNION ALL

SELECT
  -- id determinístico (view não pode usar gen_random_uuid: quebraria estabilidade)
  md5(v.id::text || ':' || mo.comp_oben::text)::uuid  AS id,
  v.empresa,
  v.nfe_chave_acesso,          -- ⚠️ HERDADA DO PAI: num_ordens=count(DISTINCT nfe).
                               --    Com NULL o insumo conta 0 ordens e NUNCA gradua.
  v.nfe_numero,
  v.nfe_serie,
  v.data_emissao,              -- a data do consumo = a da venda do pai
  v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf,
  v.cliente_uf, v.cliente_cidade,
  mo.comp_oben                 AS sku_codigo_omie,   -- o INSUMO
  ins.codigo                   AS sku_codigo,
  ins.descricao                AS sku_descricao,
  ins.ncm                      AS sku_ncm,
  ins.unidade                  AS sku_unidade,       -- unidade do INSUMO (não 'UN' do pai)
  v.quantidade * mo.quantidade AS quantidade,        -- a explosão
  NULL::numeric                AS valor_unitario,    -- V3: receita honesta (ausente≠zero)
  NULL::numeric                AS valor_total,
  v.cfop, v.raw_data, v.created_at
FROM v_venda_items_history_efetivo v
JOIN v_pcp_malha_oben mo   ON mo.pai_oben = v.sku_codigo_omie
JOIN omie_products ins     ON ins.omie_codigo_produto = mo.comp_oben
                          AND ins.account = 'oben'
WHERE v.empresa = 'OBEN';    -- guard: nunca cruzar empresa

COMMENT ON VIEW v_sku_demanda_efetiva IS
  'Demanda = venda direta ⊕ consumo de insumo derivado da ficha técnica. A linha de consumo herda a NF do pai (num_ordens) e usa a unidade do insumo; valor de venda é NULL (insumo não gera receita). PR-2 aponta as 4 views estatísticas para cá.';

-- Segurança (padrão P0 — docs/agent/database.md §4). Esta view lê v_venda_items_history_efetivo
-- (dados de venda/cliente sensíveis, já invoker=on em prod): manter a cadeia invoker=on e
-- fechar a anon-key. v_venda_items_history_efetivo é a folha que governa venda_items_history.
REVOKE ALL ON public.v_sku_demanda_efetiva FROM anon, PUBLIC;
GRANT SELECT ON public.v_sku_demanda_efetiva TO authenticated;
```

- [ ] **Step 4: Rodar — deve PASSAR**

```bash
heavy bash db/test-reposicao-demanda-insumos-bom.sh > /tmp/bom-t3b.log 2>&1; echo $?
```
Expected: exit `0`.

- [ ] **Step 5: Sabotagem da NF herdada (o furo que mataria a feature)**

```bash
echo "→ SABOTAGEM S3: com nfe_chave_acesso NULL no sintético, o insumo perde as ordens"
P -q -c "CREATE OR REPLACE VIEW v_sku_demanda_efetiva AS
  SELECT id, empresa, nfe_chave_acesso, nfe_numero, nfe_serie, data_emissao,
         cliente_codigo_omie, cliente_razao_social, cliente_cnpj_cpf, cliente_uf, cliente_cidade,
         sku_codigo_omie, sku_codigo, sku_descricao, sku_ncm, sku_unidade,
         quantidade, valor_unitario, valor_total, cfop, raw_data, created_at
  FROM v_venda_items_history_efetivo
  UNION ALL
  SELECT md5(v.id::text || ':' || mo.comp_oben::text)::uuid, v.empresa,
         NULL::text,                       -- ⬅ SABOTAGEM: NF nula
         v.nfe_numero, v.nfe_serie, v.data_emissao,
         v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf, v.cliente_uf, v.cliente_cidade,
         mo.comp_oben, ins.codigo, ins.descricao, ins.ncm, ins.unidade,
         v.quantidade * mo.quantidade, NULL::numeric, NULL::numeric,
         v.cfop, v.raw_data, v.created_at
  FROM v_venda_items_history_efetivo v
  JOIN v_pcp_malha_oben mo ON mo.pai_oben = v.sku_codigo_omie
  JOIN omie_products ins ON ins.omie_codigo_produto = mo.comp_oben AND ins.account='oben'
  WHERE v.empresa='OBEN';"

got=$(Pq -c "SELECT count(DISTINCT nfe_chave_acesso) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
if [ "$got" != "0" ]; then
  echo "  ✗ SABOTAGEM S3 INÚTIL: o assert I1 não detecta a perda da NF"; exit 1
fi
echo "  ✓ S3 ok (NF nula → 0 ordens distintas → o insumo ficaria preso em AGUARDANDO_SEGUNDA_ORDEM)"
PASS=$((PASS+1))

# restaurar a versão real
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"
got=$(Pq -c "SELECT count(DISTINCT nfe_chave_acesso) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
assert_eq "S3r restaurado: 2 ordens de novo" "2" "$got"
```

- [ ] **Step 6: Commit**

```bash
git add db/reposicao-demanda-insumos-bom.sql db/test-reposicao-demanda-insumos-bom.sh
git commit -m "feat(reposicao): v_sku_demanda_efetiva — explosao de BOM na demanda (NF do pai, valor NULL)"
```

---

### Task 4: Provar que o PR-1 é INERTE

**Files:**
- Modify: `db/test-reposicao-demanda-insumos-bom.sh` (append)

**Interfaces:**
- Consumes: tudo acima.
- Produces: garantia de que aplicar este PR em prod **não muda nenhum número**.

**Baseline:** as tabelas `base_v_sku_*` já foram criadas no bootstrap do Task 2 (logo após as 3 dependências e **antes** do candidato). Nada a fazer aqui além dos asserts.

- [ ] **Step 1: Assert de inércia — as 4 views não mudam**

```bash
echo "→ O. INÉRCIA: cada view estatística retorna IDÊNTICO antes/depois do PR-1"
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  got=$(Pq -c "SELECT count(*) FROM (
                 (SELECT * FROM ${v} EXCEPT ALL SELECT * FROM base_${v})
                 UNION ALL
                 (SELECT * FROM base_${v} EXCEPT ALL SELECT * FROM ${v})) d;")
  assert_eq "O:${v} inalterada" "0" "$got"
done
```

- [ ] **Step 2: Assert de dependência — ninguém consome a view nova ainda**

```bash
echo "→ P. pg_depend: nada depende de v_sku_demanda_efetiva (é o que torna o PR-1 inerte)"
got=$(Pq -c "SELECT count(*) FROM pg_depend d
             JOIN pg_rewrite r ON r.oid=d.objid
             JOIN pg_class dep ON dep.oid=r.ev_class
             JOIN pg_class src ON src.oid=d.refobjid
             WHERE src.relname='v_sku_demanda_efetiva' AND dep.relname<>'v_sku_demanda_efetiva';")
assert_eq "P1 nenhuma view depende da nova (PR-1 inerte)" "0" "$got"

echo "→ Q. v_venda_items_history_efetivo NÃO foi recriada por este PR"
got=$(Pq -c "SELECT count(*) FROM pg_views
             WHERE viewname='v_venda_items_history_efetivo'
               AND definition ILIKE '%v_pcp_malha_oben%';")
assert_eq "Q1 a view de venda/preco segue intocada" "0" "$got"
```

- [ ] **Step 3: Rodar e commitar**

```bash
heavy bash db/test-reposicao-demanda-insumos-bom.sh > /tmp/bom-t4.log 2>&1; echo $?
git add db/test-reposicao-demanda-insumos-bom.sh
git commit -m "test(reposicao): prova de inercia do PR-1 (EXCEPT ALL + pg_depend)"
```

---

### Task 5: Codex challenge do SQL + handoff de apply

**Files:**
- Create: `docs/handoff/2026-07-09-pr1-bom-insumos-apply.md` (bloco p/ SQL Editor + validação)

**Interfaces:**
- Consumes: `db/reposicao-demanda-insumos-bom.sql` provado.
- Produces: o material que o founder cola no SQL Editor do Lovable.

- [ ] **Step 1: Codex challenge sobre o SQL (money-path, conduzido pelo Claude)**

```bash
cat db/reposicao-demanda-insumos-bom.sql | scripts/codex-async.sh -r xhigh - 
```
(rodar com `run_in_background: true`; prompt deve pedir: dupla contagem, cardinalidade, NULL-blindness, `min()` sob `HAVING`, `UNION ALL` shape/tipos, e se a quarentena realmente cobre o complemento do elegível.)

- [ ] **Step 2: Escrever o handoff de apply**

O bloco SQL fenced (` ```sql `) com o conteúdo integral de `db/reposicao-demanda-insumos-bom.sql`, rotulado `🟣 Lovable → SQL Editor → cola → Run`, seguido da **query de validação pós-apply**:

```sql
-- Validação pós-apply (read-only). Esperado: elegiveis=23, quarentena_unidade=33.
SELECT 'elegiveis_pares'      AS chk, count(*)::text FROM v_pcp_malha_oben
UNION ALL
SELECT 'insumos_elegiveis',   count(DISTINCT comp_oben)::text FROM v_pcp_malha_oben
UNION ALL
SELECT 'quarentena_unidade',  count(DISTINCT comp_oben)::text
  FROM v_pcp_malha_oben_quarentena WHERE motivo='unidade_divergente'
UNION ALL
SELECT 'base_tingimix_na_ficha', count(*)::text
  FROM v_pcp_malha_oben WHERE comp_oben = 8689961993
UNION ALL
SELECT 'demanda_base_L_dia',  round(sum(quantidade)/90.0, 4)::text
  FROM v_sku_demanda_efetiva
  WHERE sku_codigo_omie = 8689961993 AND data_emissao >= CURRENT_DATE - 90;
```

- [ ] **Step 3: Verificação pós-apply (eu rodo, read-only)**

```bash
~/.config/afiacao/psql-ro -c "SELECT count(*) FROM v_pcp_malha_oben;"
~/.config/afiacao/psql-ro -c "SELECT motivo, count(*) FROM v_pcp_malha_oben_quarentena GROUP BY 1 ORDER BY 2 DESC;"
```
Expected: `v_pcp_malha_oben` com os 23 insumos elegíveis; quarentena listando `unidade_divergente` ≈ 33 insumos.

**E o assert que fecha o PR-1:** nenhum número do cockpit mudou (nada consome a view nova ainda).

- [ ] **Step 4: Commit + PR draft**

```bash
git add docs/handoff/2026-07-09-pr1-bom-insumos-apply.md
git commit -m "docs(handoff): apply do PR-1 (views de demanda de insumo) + validacao pos-apply"
gh pr create --draft --title "feat(reposicao): PR-1 — fonte de demanda de insumos via explosao de BOM" \
  --body "⚠️ migration manual (SQL Editor). Inerte: nao religa as 4 views. Spec: docs/superpowers/specs/2026-07-09-...-design.md"
```

> **DRAFT** até a verificação pós-apply passar (o auto-merge do repo mergeia PR não-draft assim que o CI fica verde).

---

## Self-Review

**Spec coverage:**

| Requisito do spec | Onde é implementado |
|---|---|
| §4.1 guard de cardinalidade fail-closed (nunca `LIMIT 1`) | Task 1 (`n_pai_oben=1`) · Task 2 asserts C1/C2 · sabotagem S2 |
| §4.1 guard de **unidade** (33 em quarentena) | Task 1 (`un_ficha = un_estoque`) · Task 2 B1/B2 · sabotagem S1 |
| §4.1 dedup falsificável (exata dedup / divergente quarentena) | Task 1 (`HAVING count(DISTINCT quantidade)=1`) · Task 2 F1/F2/G1/G2 |
| §4.1 auto-referência | Task 1 (`pai_oben <> comp_oben`) · Task 2 D1/D2 |
| §4.1 `perc_perda` | Task 1 (`perc_perda = 0`) · Task 2 E1/E2 |
| §4.1 interação com o de-para de consolidação (Codex #7) | Task 1 (CTE `efetivo` traduz pai **e** componente) |
| §4.2 NF herdada do pai (Codex #5) | Task 3 I1/I2 · **sabotagem S3** |
| §4.2 unidade/descrição do insumo (Codex #6) | Task 3 K1 |
| §4.2 valor NULL (V3, `ausente≠zero`) | Task 3 J1/J2 |
| §7 sem fan-out | Task 3 H1/H2 |
| §8 PR-1 inerte | Task 4 O (EXCEPT ALL ×4) · P1 (`pg_depend`) · Q1 |
| §2.1 quarentena listada, não sumida | Task 1 (`v_pcp_malha_oben_quarentena`) · Task 5 validação |
| §5.1 **V3 (criticidade por custo)** | **PR-2** — fora deste plano por design (aqui nada consome a demanda) |

**Placeholders:** ✅ eliminados. Todos os asserts (A–Q) e as 3 sabotagens (S1–S3) têm bash executável. O seed da malha usa o helper `set_malha()` (UPSERT de payload jsonb em `pcp_malha_staging`), e a ordem das 3 dependências do harness está explícita — ambos resolvidos no pré-voo contra a prod, não deixados ao implementador.

**Type consistency:** `v_pcp_malha_oben(pai_oben, comp_oben, quantidade, unidade)` — nomes idênticos no Task 3 (`mo.pai_oben`, `mo.comp_oben`, `mo.quantidade`) e nas 3 sabotagens. `v_sku_demanda_efetiva` preserva as **22 colunas** de `venda_items_history` na ordem do `information_schema` (`id … created_at`), condição para o PR-2 trocar só o `FROM`. `md5(text)::uuid` verificado em prod. Asserts nomeados A–Q sem colisão (Task 2: A–G+S1/S2; Task 3: H–N+S3; Task 4: O–Q).

**Escopo:** um plano, uma entrega testável e reversível (3 views novas, zero view existente recriada). PR-2 (religamento + V3) é plano separado — muda comportamento e merece seu próprio ciclo de prova.
