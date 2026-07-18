# Tintométrico Fase 1c — Protocolo de staging como UNIDADE (expected_item_count)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline — money-path com prova PG17 local; subagente não tem o psql-ro nem o contexto do ritual). Steps usam checkbox (`- [ ]`).

**Goal:** fechar o resíduo declarado da v3 do Guard 4 — subconjunto de itens que atravessa fronteira de chunk vira receita "legítima" (fail-open), corrida de ingestão cria fórmula vazia em chave nova, e transição legítima para base pura fica eternamente barrada — fazendo a fonte DECLARAR o tamanho do conjunto (`expected_item_count`) e a promoção só aceitar conjunto íntegro.

**Architecture:** 1 coluna nova nullable em `tint_staging_formulas` + gate `_eu_incompleta` na RPC `tint_promote_sync_run` (v4, corpo verbatim da v3 + 3 mudanças cirúrgicas) + 1 linha no edge `tint-sync-agent` (declara `(f.itens||[]).length` no INSERT do header). Protocolo NULL-compatível: staging legado/simulação (expected NULL) segue o comportamento v3 exato — zero regressão nos 217k headers atuais (59% em runs `error` LEGÍTIMOS — filtrar por status de run é PROIBIDO, lição da v2 descartada).

**Tech Stack:** PostgreSQL 17 local (prova), plpgsql, Deno edge (Supabase), harness `db/test-tint-promote.sh`.

## Global Constraints

- **Money-path:** precisão > recall; ausente ≠ zero; nunca fabricar número; receita anterior SEMPRE preservada quando o novo lote não prova integridade. `docs/agent/money-path.md`.
- **Prova obrigatória:** prove-sql-money-path (PG17 + falsificação com dente visível) ANTES do handoff; `/codex` xhigh no design (rodando — parecer entra na Task 4) e no diff.
- **CREATE OR REPLACE:** pré-flight `pg_get_functiondef` da PROD antes de basear o corpo (apply manual diverge do repo; a última a recriar VENCE). Corpo v4 = verbatim v3 + mudanças marcadas.
- **⚠️ ORDEM DE DEPLOY:** migration (SQL Editor) ANTES do edge — o edge novo INSERTa a coluna `expected_item_count`; sem a coluna, PostgREST rejeita o INSERT do header (PGRST204) e o sync de fórmulas PARA.
- **Armadilha plpgsql:** alias `r` é variável `record` declarada na função — identificador da variável VENCE o alias, compila e explode em runtime. Usar `fl`/`eu`/`si`/`inc`.
- **Deploy Lovable = 3 camadas manuais** (migration SQL Editor · edge pelo chat verbatim · sem Publish aqui — não há mudança de frontend). Merge ≠ produção.
- **Timestamp de migration:** `20260718170000` (conferido livre; colisão com worktrees paralelas checada em preflight).

> ## ⚖️ REVISÃO pós-Codex (xhigh, 2026-07-18) — o plano abaixo foi EXECUTADO com estas alterações
>
> O challenge devolveu 3 P1 + 4 P2 + 1 P3; veredito global "rejeitar como está; D2 aproveitável". Fold aplicado:
> - **D4 REJEITADO e removido** (era: expected=0 declarado limpa a receita). Motivo-raiz: o CONECTOR (`connector/sayersync/pg.go` — flat `:262`, child `:317`) OMITE slot com corante vazio/qtd inválida ANTES do POST, então o `expected` medido na edge conta o array JÁ FILTRADO — 0/ausente não distingue "base pura confirmada" de "tudo filtrado por corrupção". O guard (c) ficou VERBATIM v3 (todo vazio barra). A transição base-pura vai pra **Fase 1d** (sinal `is_base_pura` da fonte + conector preserva/rejeita inválidos + testes de contrato Go→edge).
> - **D1 alterado:** edge grava `Array.isArray(f.itens) ? f.itens.length : null` (ausência de `itens` por regressão de serialização NUNCA vira 0); significado da coluna = "linhas que a EDGE recebeu", não "declarado pela fonte"; id do header PRÉ-GERADO na edge (mata a associação posicional do `.select("id")` — P2).
> - **D2 mantido** + `CHECK (expected_item_count IS NULL OR >= 0) NOT VALID` + `header_sync_run_id` no error_details (o run DONO do header incompleto, não só o promotor).
> - **D3 mantido com honestidade nova:** COUNT bruto prova transporte edge→banco; a independência 4a/4b só vale pro que CHEGA ao staging — o furo pré-existente do conector está documentado (não é desta fase, não regride).
> - **D6 ajustado:** cenários renumerados C24–C29 (C22/C23 já existiam no harness — colisão de UUID apontada pelo Codex já estava resolvida na implementação); C26 e C29 INVERTIDOS para barrar; falsificação F1c mantida (gate de transporte).
> - Mismatch transitório de corrida: mantido o re-log (padrão honesto do Guard 4), com autoria correta via `header_sync_run_id`; sem fallback ao header antigo (posição confirmada pelo Codex).

## Decisões de design (D1–D6) — challenge Codex em voo

- **D1** Coluna `expected_item_count integer` NULLABLE, sem default. Edge preenche SÓ no fluxo real `handleFormulas`; simulação/sintéticos ficam NULL.
- **D2** Gate `_eu_incompleta`: expected declarado e COUNT(*) bruto ≠ expected → fórmula INTEIRA fora de `_expand_uniq` (todas as embalagens) + `tint_sync_errors`. Posição: DEPOIS do vencedor da colisão (mesma do Guard 4), ANTES do guard (c). Sem fallback ao perdedor nem ao header antigo completo (fallback promoveria estado velho como novo).
- **D3** COUNT **bruto** (integridade de TRANSPORTE); validade de conteúdo continua nos guards 4a/4b (camadas independentes).
- **D4** Guard (c) `_eu_sem_receita` refinado: só barra vazio quando `expected IS NULL` (ambíguo/legado). Conjunto DECLARADO e íntegro sem item válido (expected=0, ou placeholders completos) = base pura de facto → promove e LIMPA a receita (a transição legítima destravada).
- **D5** expected NULL → caminho v3 intacto (zero regressão).
- **D6** Prova: C22–C27 + falsificação estilo C13 (sabotar → dano visível → restaurar) + C1–C21 sem regressão.

---

### Task 1: Migration `20260718170000_tint_fase1c_expected_item_count.sql`

**Files:**
- Create: `supabase/migrations/20260718170000_tint_fase1c_expected_item_count.sql`
- Fonte do corpo: `supabase/migrations/20260718140000_tint_promote_guard4_v3.sql` (linhas 155–899)

**Interfaces:**
- Produces: coluna `tint_staging_formulas.expected_item_count integer NULL`; RPC `tint_promote_sync_run(uuid)` v4 com gate `_eu_incompleta` e guard (c) refinado. Mensagem de erro nova (Task 3 assere por `LIKE '%staging incompleto%'`): `'staging incompleto: itens ingeridos ≠ declarados (expected_item_count) — fórmula NÃO promovida, receita anterior preservada'`.

- [ ] **Step 1: Pré-flight de deriva — prod × repo**

```bash
~/.config/afiacao/psql-ro -X -A -t -c "SELECT pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure)" > /tmp/prod-fn.txt
# extrair o corpo da v3 do repo (do CREATE à última linha antes do REVOKE) e diffar:
sed -n '155,895p' supabase/migrations/20260718140000_tint_promote_guard4_v3.sql > /tmp/repo-fn.txt
diff <(grep -v '^--' /tmp/prod-fn.txt | tr -s ' \n') <(grep -v '^--' /tmp/repo-fn.txt | tr -s ' \n') | head -40
```
Esperado: diferenças só de formatação do functiondef (aspas/SET clauses). Qualquer diferença SEMÂNTICA → PARAR e investigar (a prod pode ter recebido hotfix que o repo não tem — a v4 precisa partir do que está SERVIDO).

- [ ] **Step 2: Conferir colisão de timestamp com worktrees paralelas**

```bash
ls supabase/migrations/ | grep 20260718; git fetch origin main --quiet && git log origin/main --oneline -5
```
Esperado: `20260718170000` inexistente. Se colidir, usar `20260718173000`.

- [ ] **Step 3: Escrever a migration**

Estrutura (cabeçalho no padrão da casa + 4 blocos):

```sql
-- 20260718170000_tint_fase1c_expected_item_count.sql
-- FASE 1c (money-path) — protocolo de staging como UNIDADE. Fecha o RESÍDUO declarado no cabeçalho
-- da 20260718140000 (v3): (R1) subconjunto VÁLIDO de itens que sobra de falha de chunk + cleanup
-- falho (tint-sync-agent :515-535, .delete() sem checagem :523) é indistinguível de receita
-- legítima → substituía receita íntegra; (R2) promoção concorrente lê header antes dos itens e em
-- chave oficial NOVA o guard (c) não barra (exige oficial COM receita) → criava fórmula vazia
-- ativa (o mal das 28.609 em miniatura); (R3) transição legítima p/ base pura ficava SEMPRE
-- barrada (vazio ambíguo). MECANISMO: a fonte DECLARA o tamanho do conjunto no header
-- (expected_item_count, edge :447-462) e a promoção só aceita a fórmula quando o COUNT(*) BRUTO
-- dos itens ingeridos BATE. NULL = protocolo legado/simulação → comportamento v3 EXATO (zero
-- regressão nos 217k headers atuais; filtrar por tint_sync_runs.status segue PROIBIDO — 59% dos
-- headers legítimos vivem em runs 'error', lição da v2 DESCARTADA).
-- COUNT BRUTO de propósito: o gate prova INTEGRIDADE DE TRANSPORTE; a VALIDADE do conteúdo segue
-- nos guards 4a/4b (camadas independentes). Vazio DECLARADO íntegro (expected=0, ou N placeholders
-- id_corante=''/qtd 0) = base pura DE FACTO → promove e LIMPA a receita (R3 destravado).
-- ⚠️ ORDEM DE DEPLOY: esta migration ANTES do deploy do edge — o edge novo INSERTa a coluna; sem
-- ela o PostgREST rejeita o header (PGRST204) e o sync de fórmulas PARA.
-- Provado: db/test-tint-promote.sh C22-C27 + falsificação. Plano:
-- docs/superpowers/plans/2026-07-18-tint-fase1c-staging-unidade.md. SQL Editor (§deploy.md).

-- (1) coluna do protocolo
ALTER TABLE public.tint_staging_formulas ADD COLUMN IF NOT EXISTS expected_item_count integer;
COMMENT ON COLUMN public.tint_staging_formulas.expected_item_count IS
  'Protocolo Fase 1c: nº de linhas de item que a FONTE declarou p/ este header (edge handleFormulas). NULL = protocolo legado/simulação (promoção usa o caminho v3). 0 = base pura DECLARADA (limpa receita). A promoção só aceita a fórmula quando COUNT(*) bruto de tint_staging_formula_itens bate.';

-- (2) CREATE OR REPLACE tint_promote_sync_run — corpo VERBATIM da 20260718140000 com 3 mudanças:
--   [1c-A] _formulas_latest projeta expected_item_count (acompanha o header LATEST escolhido);
--   [1c-B] gate _eu_incompleta DEPOIS do DELETE do Guard 4 (pós-vencedor) e ANTES do guard (c);
--   [1c-C] guard (c) _eu_sem_receita só barra quando expected_item_count IS NULL.
```

As 3 mudanças no corpo (o resto é verbatim da v3):

**[1c-A]** em `_formulas_latest` (v3 linha ~389-399), adicionar a projeção:
```sql
  SELECT DISTINCT ON (cor_id, cod_produto, id_base, COALESCE(subcolecao, ''), personalizada)
         id AS staging_formula_id, cor_id,
         CASE WHEN nome_cor IS NULL OR btrim(nome_cor) = '' THEN cor_id ELSE nome_cor END AS nome_cor,
         cod_produto, id_base, id_embalagem,
         subcolecao, volume_final_ml, personalizada,
         expected_item_count          -- [1c-A] protocolo Fase 1c: acompanha o header latest
  FROM alvo
```
(`_fl_resolved` herda via `fl.*` — nada a mudar lá.)

**[1c-B]** logo APÓS o `DELETE FROM _expand_uniq eu USING _fl_corrompida c ...` (v3 linha ~635-637) e ANTES do bloco `_eu_sem_receita`:
```sql
  -- ══════════════════════════════════════════════════════════════════════════
  -- GATE 1c (_eu_incompleta) — INTEGRIDADE DE TRANSPORTE do conjunto de itens. O header declara
  -- quantas linhas de item a fonte enviou (expected_item_count, edge handleFormulas); se o COUNT(*)
  -- BRUTO ingerido difere, o conjunto NÃO chegou inteiro (itens atravessam a fronteira de chunk de
  -- 1000 e o cleanup do edge pode falhar silencioso — :523) OU a promoção concorrente leu a ingestão
  -- a meio caminho. A fórmula INTEIRA sai (todas as embalagens), receita anterior preservada; em
  -- chave NOVA, nem header nasce (fecha o "fórmula vazia ativa" que o guard (c) não cobre).
  -- COUNT BRUTO de propósito (transporte ≠ validade): dose inválida é papel dos guards 4a/4b.
  -- NULL = protocolo legado/simulação → não entra aqui (caminho v3 intacto). Posição: DEPOIS do
  -- vencedor da colisão (mesma lição do Guard 4 — sem fallback ao perdedor) e SEM fallback ao
  -- header completo mais antigo (promoveria estado velho como se fosse novo).
  CREATE TEMP TABLE _eu_incompleta ON COMMIT DROP AS
  SELECT DISTINCT eu.staging_formula_id, fl.cor_id, fl.cod_produto, fl.id_base,
         fl.expected_item_count AS declarados,
         COALESCE(si.n, 0)      AS ingeridos
  FROM _expand_uniq eu
  JOIN _fl_resolved fl ON fl.staging_formula_id = eu.staging_formula_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM tint_staging_formula_itens si
    WHERE si.staging_formula_id = eu.staging_formula_id
  ) si ON true
  WHERE fl.expected_item_count IS NOT NULL
    AND fl.expected_item_count <> COALESCE(si.n, 0);

  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT DISTINCT p_sync_run_id, 'formula_promote', inc.cor_id,
         'staging incompleto: itens ingeridos ≠ declarados (expected_item_count) — fórmula NÃO promovida, receita anterior preservada',
         jsonb_build_object('staging_formula_id', inc.staging_formula_id,
                            'cod_produto', inc.cod_produto, 'id_base', inc.id_base,
                            'declarados', inc.declarados, 'ingeridos', inc.ingeridos)
  FROM _eu_incompleta inc;
  GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

  DELETE FROM _expand_uniq eu
  USING _eu_incompleta inc
  WHERE inc.staging_formula_id = eu.staging_formula_id;
```

**[1c-C]** em `_eu_sem_receita` (v3 linha ~647-663), trocar o `FROM` e adicionar a condição:
```sql
  CREATE TEMP TABLE _eu_sem_receita ON COMMIT DROP AS
  SELECT eu.staging_formula_id, eu.cor_id, eu.emb_id
  FROM _expand_uniq eu
  JOIN _fl_resolved fl ON fl.staging_formula_id = eu.staging_formula_id   -- [1c-C]
  WHERE fl.expected_item_count IS NULL     -- [1c-C] vazio DECLARADO íntegro (expected=0 ou
                                           -- placeholders completos) NÃO barra: base pura de facto
                                           -- → promove e LIMPA (R3). Só o vazio AMBÍGUO (legado)
                                           -- continua barrado — comportamento v3 exato.
    AND NOT EXISTS (
      SELECT 1 FROM tint_staging_formula_itens si
      WHERE si.staging_formula_id = eu.staging_formula_id
        AND btrim(COALESCE(si.id_corante, '')) <> ''
        AND COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false)
    )
    AND EXISTS (
      SELECT 1 FROM tint_formulas f
      JOIN tint_formula_itens fi ON fi.formula_id = f.id
      WHERE f.account = v_account
        AND f.cor_id = eu.cor_id AND f.produto_id = eu.produto_id AND f.base_id = eu.base_id
        AND COALESCE(f.subcolecao_id, v_zero_uuid) = COALESCE(eu.subcolecao_id, v_zero_uuid)
        AND f.embalagem_id = eu.emb_id
    );
```
⚠️ `_expand_uniq` NÃO projeta `produto_id/base_id/subcolecao_id`? Projeta sim (v3 linha ~621-624: `produto_id, base_id, subcolecao_id, sku_id, emb_id`) — o EXISTS continua lendo de `eu`. Manter verbatim o resto do bloco (INSERT de erro + DELETE por `(staging_formula_id, emb_id)`).

- [ ] **Step 4: Fechar com REVOKE + sentinela (verbatim v3)**

```sql
REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM anon, authenticated, PUBLIC;
SELECT 'tint_promote_sync_run FASE 1c (expected_item_count) OK' AS status;
```

---

### Task 2: Edge `tint-sync-agent` — declarar o conjunto

**Files:**
- Modify: `supabase/functions/tint-sync-agent/index.ts:447-462` (montagem de `formulaRows` no `handleFormulas`)

**Interfaces:**
- Consumes: coluna criada na Task 1 (⚠️ ordem de DEPLOY; em dev/PG17 o harness aplica a migration antes).
- Produces: headers do fluxo REAL com `expected_item_count = f.itens.length`; simulação/sintéticos (`:807`, `:823`, `:854`) INALTERADOS (ficam NULL).

- [ ] **Step 1: Adicionar a declaração no map de formulaRows**

```ts
      const formulaRows: Record<string, unknown>[] = validFormulas.map((f) => ({
        sync_run_id: runId,
        account: agent.account,
        store_code: agent.storeCode,
        cor_id: f.cor_id,
        nome_cor: f.nome_cor,
        cod_produto: f.cod_produto,
        id_base: f.id_base,
        id_embalagem: f.id_embalagem,
        subcolecao: f.subcolecao || null,
        volume_final_ml: f.volume_final_ml,
        preco_final: f.preco_final,
        personalizada: f.personalizada || false,
        raw_data: f,
        staging_status: "pending",
        // Fase 1c — protocolo de staging como UNIDADE: declara o tamanho do conjunto de itens que
        // ESTE header carrega. A promoção (tint_promote_sync_run v4) só aceita a fórmula quando o
        // COUNT bruto ingerido bate (fecha subconjunto por fronteira de chunk + corrida de
        // ingestão×promoção). 0 = base pura DECLARADA (limpa receita legitimamente). Os modos de
        // simulação/sintéticos NÃO declaram (NULL → caminho legado v3, fail-closed no vazio ambíguo).
        expected_item_count: (f.itens || []).length,
      }));
```

- [ ] **Step 2: Verificar que nenhum outro INSERT em tint_staging_formulas foi tocado**

```bash
grep -n "tint_staging_formulas" supabase/functions/tint-sync-agent/index.ts
```
Esperado: só o INSERT de `:471` (chunk do fluxo real) herda a coluna via formulaRows; `:523` (delete de cleanup) e os inserts de simulação (`:807`, `:823`, `:854`) inalterados.

- [ ] **Step 3: Typecheck**

```bash
heavy bun run typecheck > /tmp/tc.log 2>&1; echo $?
```
Esperado: 0. (O edge é Deno — fora do tsconfig.app; o typecheck cobre o src/. A mudança no edge é validada pelo harness e pelo deploy-verify.)

---

### Task 3: Prova PG17 — estender `db/test-tint-promote.sh` (C22–C27 + falsificação)

**Files:**
- Modify: `db/test-tint-promote.sh` (append após o C21; adicionar a migration nova na FASE 1c do loop `for MG`)

**Interfaces:**
- Consumes: migration da Task 1; padrão de seed/assert do C14 (staging → `tint_promote_sync_run` → DO $$ asserts com sentinela de header `_cNN_header_antes`).

- [ ] **Step 1: Aplicar a migration nova na sequência (nova FASE 1c no script)**

Após o bloco `FASE 1` (linha ~998), inserir:
```bash
echo ""
echo "════════ FASE 1c — migration expected_item_count (protocolo de staging como unidade) ════════"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260718170000_tint_fase1c_expected_item_count.sql" >/dev/null
P -tA -c "SELECT CASE WHEN pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure) LIKE '%_eu_incompleta%' THEN 'OK' ELSE 'FALTA' END;" | grep -qx OK \
  || { echo "✗ FASE1c: gate _eu_incompleta não está no corpo aplicado"; exit 1; }
echo "  ✓ v4 aplicada (contém _eu_incompleta)"
```
⚠️ Os cenários C14–C21 rodam DEPOIS desta fase (mover o bloco pra ANTES do C14) ou ANTES? **Decisão: aplicar a v4 logo após a v3 no MESMO loop `for MG`** (acrescentar `20260718170000_tint_fase1c_expected_item_count` à lista) — os C14–C21 então rodam JÁ sobre a v4, provando de graça a NÃO-regressão do caminho NULL (todos os seeds existentes não declaram expected). A sanidade `_eu_incompleta` entra logo após o loop.

- [ ] **Step 2: C22 — subconjunto (transporte incompleto) preserva receita íntegra**

```bash
echo ""
echo "════════ CENÁRIO 22 — Fase 1c: subconjunto (COUNT<expected) NÃO substitui receita íntegra ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Catálogo P22/B22/E22 (900ml) + fórmula BOA COR22 (2 itens, protocolo novo: expected=2).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2200000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('e2200000-0000-0000-0000-000000000001','oben','L1','P22','Produto 22');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('e2200000-0000-0000-0000-000000000001','oben','L1','B22','Base 22');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('e2200000-0000-0000-0000-000000000001','oben','L1','E22','Galão 22',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('e2200000-0000-0000-0000-000000000001','oben','L1','P22','B22','E22');
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2200000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff220000-0000-0000-0000-000000000001','e2200000-0000-0000-0000-000000000002','oben','L1','COR22','Boa22','P22','B22','E22',900,false,2);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('e2200000-0000-0000-0000-000000000002','ff220000-0000-0000-0000-000000000001','AX22',1,10),
       ('e2200000-0000-0000-0000-000000000002','ff220000-0000-0000-0000-000000000001','VM22',2,5);
SELECT tint_promote_sync_run('e2200000-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('e2200000-0000-0000-0000-000000000002');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben' AND f.cor_id='COR22';
  IF n <> 2 THEN RAISE EXCEPTION 'C22.0 FALHOU: COR22 boa deveria ter 2 itens, achei %', n; END IF;
  RAISE NOTICE 'OK C22.0 — protocolo novo íntegro (expected=2, 2 itens) promove normal';
END $$;
SQL
# sentinela de header + run com SUBCONJUNTO: expected=3 mas só 2 itens chegaram (chunk perdido).
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP TABLE IF EXISTS _c22_header_antes;
CREATE TABLE _c22_header_antes AS
  SELECT id, preco_final_sayersystem, importacao_id, updated_at, desativada_em
  FROM tint_formulas WHERE account='oben' AND cor_id='COR22';
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2200000-0000-0000-0000-0000000000c0','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff220000-0000-0000-0000-0000000000c0','e2200000-0000-0000-0000-0000000000c0','oben','L1','COR22','Boa22','P22','B22','E22',900,false,3);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('e2200000-0000-0000-0000-0000000000c0','ff220000-0000-0000-0000-0000000000c0','AX22',1,99),
       ('e2200000-0000-0000-0000-0000000000c0','ff220000-0000-0000-0000-0000000000c0','VM22',2,99);
SELECT tint_promote_sync_run('e2200000-0000-0000-0000-0000000000c0');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; qax numeric; nerr int;
BEGIN
  -- (a) receita ÍNTEGRA preservada (10/5) — o subconjunto VÁLIDO (99/99) NÃO entrou.
  SELECT count(*) INTO n FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben' AND f.cor_id='COR22';
  IF n <> 2 THEN RAISE EXCEPTION 'C22.1 FALHOU: COR22 deveria seguir com 2 itens, achei %', n; END IF;
  SELECT max(fi.qtd_ml) FILTER (WHERE c.id_corante_sayersystem='AX22') INTO qax
    FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes c ON c.id=fi.corante_id
    WHERE f.account='oben' AND f.cor_id='COR22';
  IF qax IS DISTINCT FROM 10 THEN RAISE EXCEPTION 'C22.2 FALHOU: receita substituída pelo subconjunto (AX22=%, esperado 10)', qax; END IF;
  -- (b) erro 'staging incompleto' logado com counts.
  SELECT count(*) INTO nerr FROM tint_sync_errors WHERE sync_run_id='e2200000-0000-0000-0000-0000000000c0'
    AND entity_type='formula_promote' AND entity_id='COR22' AND error_message LIKE '%staging incompleto%'
    AND (error_details->>'declarados')::int = 3 AND (error_details->>'ingeridos')::int = 2;
  IF nerr < 1 THEN RAISE EXCEPTION 'C22.3 FALHOU: incompleta não logou (nerr=%)', nerr; END IF;
  -- (c) header intacto (upsert não rodou).
  IF EXISTS (
    SELECT 1 FROM tint_formulas f JOIN _c22_header_antes a ON a.id = f.id
    WHERE f.preco_final_sayersystem IS DISTINCT FROM a.preco_final_sayersystem
       OR f.importacao_id           IS DISTINCT FROM a.importacao_id
       OR f.updated_at              IS DISTINCT FROM a.updated_at
       OR f.desativada_em           IS DISTINCT FROM a.desativada_em
  ) THEN RAISE EXCEPTION 'C22.4 FALHOU: header de COR22 alterado pelo run incompleto'; END IF;
  RAISE NOTICE 'OK C22 — subconjunto (declarados=3, ingeridos=2) barrado: receita {10,5} + header intactos, erro logado';
END $$;
SQL
```

- [ ] **Step 3: C23 — subconjunto em chave NOVA não cria header nem itens**

```bash
echo ""
echo "════════ CENÁRIO 23 — Fase 1c: subconjunto em chave NOVA não cria fórmula ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2300000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
-- chave NOVA COR23 no catálogo P22/B22/E22 (já vendável): expected=2 mas SÓ 1 item chegou.
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff230000-0000-0000-0000-000000000001','e2300000-0000-0000-0000-000000000001','oben','L1','COR23','Nova23','P22','B22','E22',900,false,2);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('e2300000-0000-0000-0000-000000000001','ff230000-0000-0000-0000-000000000001','AX22',1,7);
SELECT tint_promote_sync_run('e2300000-0000-0000-0000-000000000001');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; nerr int;
BEGIN
  SELECT count(*) INTO n FROM tint_formulas WHERE account='oben' AND cor_id='COR23';
  IF n <> 0 THEN RAISE EXCEPTION 'C23.1 FALHOU: chave nova incompleta criou % header(s) — fórmula parcial/vazia ativa', n; END IF;
  SELECT count(*) INTO nerr FROM tint_sync_errors WHERE sync_run_id='e2300000-0000-0000-0000-000000000001'
    AND entity_type='formula_promote' AND entity_id='COR23' AND error_message LIKE '%staging incompleto%';
  IF nerr < 1 THEN RAISE EXCEPTION 'C23.2 FALHOU: incompleta em chave nova não logou'; END IF;
  RAISE NOTICE 'OK C23 — chave nova com transporte incompleto: nada criado, erro logado';
END $$;
SQL
```

- [ ] **Step 4: C24 — base pura DECLARADA (expected=0) limpa a receita (transição legítima)**

```bash
echo ""
echo "════════ CENÁRIO 24 — Fase 1c: base pura DECLARADA (expected=0) LIMPA a receita ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- COR22 tem receita {10,5}. A fonte agora declara base pura: expected=0, 0 itens.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2400000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff240000-0000-0000-0000-000000000001','e2400000-0000-0000-0000-000000000001','oben','L1','COR22','Boa22','P22','B22','E22',900,false,0);
SELECT tint_promote_sync_run('e2400000-0000-0000-0000-000000000001');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; nerr int; ndesativ int;
BEGIN
  -- (a) receita LIMPA (0 itens) — a transição legítima que a v3 barrava.
  SELECT count(*) INTO n FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben' AND f.cor_id='COR22';
  IF n <> 0 THEN RAISE EXCEPTION 'C24.1 FALHOU: base pura declarada NÃO limpou (COR22 ainda tem % itens)', n; END IF;
  -- (b) fórmula segue ATIVA (promovida, não desativada).
  SELECT count(*) INTO ndesativ FROM tint_formulas WHERE account='oben' AND cor_id='COR22' AND desativada_em IS NOT NULL;
  IF ndesativ <> 0 THEN RAISE EXCEPTION 'C24.2 FALHOU: base pura declarada desativou a fórmula'; END IF;
  -- (c) SEM erro de 'sem receita'/'incompleto' neste run p/ COR22.
  SELECT count(*) INTO nerr FROM tint_sync_errors WHERE sync_run_id='e2400000-0000-0000-0000-000000000001'
    AND entity_id='COR22' AND (error_message LIKE '%sem receita%' OR error_message LIKE '%staging incompleto%');
  IF nerr <> 0 THEN RAISE EXCEPTION 'C24.3 FALHOU: base pura declarada gerou % erro(s) — deveria promover limpo', nerr; END IF;
  RAISE NOTICE 'OK C24 — expected=0 declarado: receita limpa, fórmula ativa, zero erro';
END $$;
SQL
```

- [ ] **Step 5: C25 — vazio AMBÍGUO (expected NULL) segue barrado (regressão v3 zero)**

```bash
echo ""
echo "════════ CENÁRIO 25 — Fase 1c: vazio AMBÍGUO (expected NULL) segue barrado (v3 preservada) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Recompõe receita em COR22 pelo protocolo novo (expected=2), depois manda vazio AMBÍGUO (NULL).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2500000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff250000-0000-0000-0000-000000000001','e2500000-0000-0000-0000-000000000001','oben','L1','COR22','Boa22','P22','B22','E22',900,false,2);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('e2500000-0000-0000-0000-000000000001','ff250000-0000-0000-0000-000000000001','AX22',1,11),
       ('e2500000-0000-0000-0000-000000000001','ff250000-0000-0000-0000-000000000001','VM22',2,6);
SELECT tint_promote_sync_run('e2500000-0000-0000-0000-000000000001');
-- vazio ambíguo: header SEM expected e SEM itens (protocolo legado / corrida antiga).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2500000-0000-0000-0000-0000000000c0','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff250000-0000-0000-0000-0000000000c0','e2500000-0000-0000-0000-0000000000c0','oben','L1','COR22','Boa22','P22','B22','E22',900,false);
SELECT tint_promote_sync_run('e2500000-0000-0000-0000-0000000000c0');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; nerr int;
BEGIN
  SELECT count(*) INTO n FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben' AND f.cor_id='COR22';
  IF n <> 2 THEN RAISE EXCEPTION 'C25.1 FALHOU: vazio ambíguo mexeu na receita (COR22 tem % itens, esperado 2 {11,6})', n; END IF;
  SELECT count(*) INTO nerr FROM tint_sync_errors WHERE sync_run_id='e2500000-0000-0000-0000-0000000000c0'
    AND entity_id='COR22' AND error_message LIKE '%sem receita%';
  IF nerr < 1 THEN RAISE EXCEPTION 'C25.2 FALHOU: vazio ambíguo não logou o guard (c)'; END IF;
  RAISE NOTICE 'OK C25 — vazio ambíguo (NULL) barrado + logado: caminho v3 intacto';
END $$;
SQL
```

- [ ] **Step 6: C26 — expected=0 com itens>0 é mismatch (barra)**

```bash
echo ""
echo "════════ CENÁRIO 26 — Fase 1c: expected=0 com itens presentes barra (mismatch) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2600000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff260000-0000-0000-0000-000000000001','e2600000-0000-0000-0000-000000000001','oben','L1','COR22','Boa22','P22','B22','E22',900,false,0);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('e2600000-0000-0000-0000-000000000001','ff260000-0000-0000-0000-000000000001','AX22',1,42);
SELECT tint_promote_sync_run('e2600000-0000-0000-0000-000000000001');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; qax numeric; nerr int;
BEGIN
  SELECT count(*) INTO n FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben' AND f.cor_id='COR22';
  IF n <> 2 THEN RAISE EXCEPTION 'C26.1 FALHOU: mismatch 0≠1 mexeu na receita (esperado 2 itens {11,6} preservados, achei %)', n; END IF;
  SELECT max(fi.qtd_ml) FILTER (WHERE c.id_corante_sayersystem='AX22') INTO qax
    FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes c ON c.id=fi.corante_id
    WHERE f.account='oben' AND f.cor_id='COR22';
  IF qax IS DISTINCT FROM 11 THEN RAISE EXCEPTION 'C26.2 FALHOU: item 42 do mismatch entrou (AX22=%)', qax; END IF;
  SELECT count(*) INTO nerr FROM tint_sync_errors WHERE sync_run_id='e2600000-0000-0000-0000-000000000001'
    AND entity_id='COR22' AND error_message LIKE '%staging incompleto%';
  IF nerr < 1 THEN RAISE EXCEPTION 'C26.3 FALHOU: mismatch 0≠1 não logou'; END IF;
  RAISE NOTICE 'OK C26 — expected=0 com 1 item = mismatch: barrado + logado, receita {11,6} intacta';
END $$;
SQL
```

- [ ] **Step 7: C27 — placeholders completos (expected=N, N slots vazios) = base pura de facto** *(CONDICIONADO ao parecer Codex — se derrubado, inverter o assert para "barra")*

```bash
echo ""
echo "════════ CENÁRIO 27 — Fase 1c: N placeholders completos = base pura de facto (limpa) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2700000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff270000-0000-0000-0000-000000000001','e2700000-0000-0000-0000-000000000001','oben','L1','COR22','Boa22','P22','B22','E22',900,false,2);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('e2700000-0000-0000-0000-000000000001','ff270000-0000-0000-0000-000000000001','',1,NULL),
       ('e2700000-0000-0000-0000-000000000001','ff270000-0000-0000-0000-000000000001','',2,0);
SELECT tint_promote_sync_run('e2700000-0000-0000-0000-000000000001');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int;
BEGIN
  -- COUNT bruto bate (2=2), nenhum corante presente, nenhum órfão com dose → base pura DE FACTO → limpa.
  SELECT count(*) INTO n FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben' AND f.cor_id='COR22';
  IF n <> 0 THEN RAISE EXCEPTION 'C27.1 FALHOU: placeholders completos não limparam (COR22 tem % itens)', n; END IF;
  RAISE NOTICE 'OK C27 — conjunto completo só-placeholders = base pura de facto: receita limpa';
END $$;
SQL
```

- [ ] **Step 8: Falsificação F1c — sabotar o gate e exigir o DANO visível (padrão C13)**

```bash
echo ""
echo "── falsificação F1c (prova que o gate _eu_incompleta tem DENTE) ──"
# Sabota: neutraliza o predicado do gate (expected nunca difere) e re-aplica SÓ a função.
SAB="$(mktemp "${TMPDIR:-/tmp}/f1c-sab.XXXXXX.sql")"
sed 's/AND fl.expected_item_count <> COALESCE(si.n, 0)/AND false/' \
  "$REPO_ROOT/supabase/migrations/20260718170000_tint_fase1c_expected_item_count.sql" > "$SAB"
grep -q 'AND false' "$SAB" || { echo "✗ F1c: sabotagem não aplicou (predicado não encontrado — a migration mudou?)"; exit 1; }
P -v ON_ERROR_STOP=1 -q -f "$SAB" >/dev/null
# Re-roda o cenário C22 (novo run, subconjunto declarados=3/ingeridos=2 com doses 77):
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2200000-0000-0000-0000-0000000000f0','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff220000-0000-0000-0000-0000000000f0','e2200000-0000-0000-0000-0000000000f0','oben','L1','COR22','Boa22','P22','B22','E22',900,false,3);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('e2200000-0000-0000-0000-0000000000f0','ff220000-0000-0000-0000-0000000000f0','AX22',1,77),
       ('e2200000-0000-0000-0000-0000000000f0','ff220000-0000-0000-0000-0000000000f0','VM22',2,77);
SELECT tint_promote_sync_run('e2200000-0000-0000-0000-0000000000f0');
SQL
# SEM o gate, o subconjunto SUBSTITUI a receita → o dano tem de ser VISÍVEL (AX22 vira 77):
P -tA -c "SELECT max(fi.qtd_ml) FILTER (WHERE c.id_corante_sayersystem='AX22')
  FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes c ON c.id=fi.corante_id
  WHERE f.account='oben' AND f.cor_id='COR22';" | grep -qx "77" \
  || { echo "✗ F1c FALHOU: gate sabotado NÃO produziu o dano — a falsificação não morde (o assert C22 não depende do gate)"; exit 1; }
echo "  ✓ F1c — sabotado, o subconjunto SUBSTITUIU a receita (AX22=77): o gate é o que impede"
# Restaura a v4 íntegra e re-prova a preservação com um run novo:
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260718170000_tint_fase1c_expected_item_count.sql" >/dev/null
rm -f "$SAB"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('e2200000-0000-0000-0000-0000000000f1','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff220000-0000-0000-0000-0000000000f1','e2200000-0000-0000-0000-0000000000f1','oben','L1','COR22','Boa22','P22','B22','E22',900,false,3);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('e2200000-0000-0000-0000-0000000000f1','ff220000-0000-0000-0000-0000000000f1','AX22',1,88),
       ('e2200000-0000-0000-0000-0000000000f1','ff220000-0000-0000-0000-0000000000f1','VM22',2,88);
SELECT tint_promote_sync_run('e2200000-0000-0000-0000-0000000000f1');
SQL
P -tA -c "SELECT max(fi.qtd_ml) FILTER (WHERE c.id_corante_sayersystem='AX22')
  FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id JOIN tint_corantes c ON c.id=fi.corante_id
  WHERE f.account='oben' AND f.cor_id='COR22';" | grep -qx "77" \
  || { echo "✗ F1c FALHOU: v4 restaurada não preservou (AX22 devia seguir 77 — o run 88 incompleto tinha de ser barrado)"; exit 1; }
echo "  ✓ F1c — restaurada, o run incompleto (88) foi barrado de novo: receita preservada"
```

- [ ] **Step 9: Rodar o harness completo**

```bash
cd <worktree> && heavy bash db/test-tint-promote.sh > /tmp/f1c-test.log 2>&1; echo "EXIT: $?"
tail -30 /tmp/f1c-test.log
```
Esperado: `EXIT: 0`, todos os `OK C1…C27` + as 2 linhas `✓ F1c`. C1–C21 verdes = não-regressão do caminho NULL provada.

---

### Task 4: Incorporar o parecer do Codex (gate de design)

- [ ] **Step 1: Ler o parecer** (background task `bh3gikncm`; output em scratchpad/tasks). P1 → corrigir design/migração/teste ANTES de seguir; P2 → incorporar ou registrar por que não; decisão explícita sobre C27 (placeholders).
- [ ] **Step 2: Registrar no cabeçalho da migration** o resultado (padrão da casa: "Codex xhigh: N achados, fold…").

### Task 5: Commit, PR, watch e handoffs

- [ ] **Step 1: Docs vivos** — `docs/agent/tintometrico.md` (§Import: registrar o protocolo expected_item_count + a ordem de deploy; nota: se `tint-import` for reativado um dia, PRECISA preencher expected) e `docs/superpowers/plans/2026-07-17-tint-receita-perdida-remediacao.md` (marcar Fase 1c entregue com nº do PR).
- [ ] **Step 2: Commit + PR**

```bash
git add supabase/migrations/20260718170000_tint_fase1c_expected_item_count.sql supabase/functions/tint-sync-agent/index.ts db/test-tint-promote.sh docs/
git commit -m "feat(tintometrico): Fase 1c — staging como unidade (expected_item_count) fecha subconjunto de chunk e destrava base pura declarada [money-path]"
gh pr create --title "feat(tintometrico): Fase 1c — protocolo de staging como unidade (expected_item_count) [money-path]" --body "..."
```
- [ ] **Step 3: `scripts/pr-watch.sh <nº>` em background** (Bash run_in_background:true); no desfecho, PushNotification.
- [ ] **Step 4: Handoff de deploy (a ORDEM importa):** (1) migration no SQL Editor (lovable-db-operator: bloco pronto + validação pós-apply `SELECT column_name FROM information_schema.columns WHERE table_name='tint_staging_formulas' AND column_name='expected_item_count'` + functiondef LIKE '%_eu_incompleta%'); (2) SÓ DEPOIS deploy da edge `tint-sync-agent` verbatim pelo chat do Lovable; (3) validação: próximo sync run com fórmulas → headers novos com expected_item_count NOT NULL.

## Self-review (feito na escrita)

- Cobertura do spec (Fase 1c do programa): R1 subconjunto ✅ C22/C23 · R2 corrida/chave nova ✅ C23 · R3 base pura ✅ C24 (+C27) · "sem regressão nos 129k headers de runs error" ✅ C25 + C1–C21 sob v4 · critérios de aceite (a)(b)(c) do programa ✅ mapeados.
- Sem placeholders: todo step tem código/comando real. ✅
- Consistência de nomes: `_eu_incompleta` (migration = teste = sanidade), mensagem `'staging incompleto: itens ingeridos ≠ declarados…'` (migration = asserts C22.3/C23.2/C26.3), `expected_item_count` em todos os pontos. ✅
- Riscos deliberados: sem fallback ao header antigo completo (fail-closed correto); COUNT bruto ≠ validade (camadas); C27 condicionado ao Codex.
