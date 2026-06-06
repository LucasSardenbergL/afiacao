# Frente C — RPC account-aware: plano de implementação

> **Para workers:** SUB-SKILL: subagent-driven-development / executing-plans. Steps com checkbox.

**Goal:** adicionar `AND op.account = lower(p_empresa)` ao LEFT JOIN `omie_products` da RPC `gerar_pedidos_sugeridos_ciclo`, validado por PG17 robusto. Neutro hoje (preventivo).

**Architecture:** migration `CREATE OR REPLACE` (corpo **verbatim** da `20260604190000` + 1 cláusula) + harness PG17 que aplica B → semeia → roda **antes** (account-blind) → aplica C → roda **depois** (account-aware) → asserts. **Sem helper TS** (decisão Codex: cerimônia; PG17 é o oráculo).

**Tech:** Postgres 17 local (base `db/verify-snapshot-replay.sh`), bash, psql.

---

### Task 1: Migration `CREATE OR REPLACE` da RPC
**Files:** Create `supabase/migrations/2026XXXXXXXXXX_reposicao_rpc_account_aware.sql`

- [ ] Copiar a RPC **verbatim** da `20260604190000` (linhas 46-211) — corpo idêntico (mínimo forçado + blindagem fornecedor + fail-closed tipo_produto + guarda '04').
- [ ] **Única mudança:** após `LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text`, adicionar nova linha `     AND op.account = lower(p_empresa)`. Comentário `[ACCOUNT-AWARE]` explicando.
- [ ] NÃO incluir a coluna (PARTE A) nem a view (PARTE C) de B — só o `CREATE OR REPLACE FUNCTION`. Assume B aplicada (runbook/preflight garante).
- [ ] Cabeçalho: escopo (só account no JOIN), neutro-hoje, "aplicar APÓS `20260604190000`", runbook de preflight (`pg_get_functiondef` + diff + transação + fora do cron `15 9 * * *`).
- [ ] `SELECT` de validação no fim (a RPC existe).

### Task 2: Harness PG17 `db/test-rpc-account-aware.sh`
**Files:** Create `db/test-rpc-account-aware.sh` (espelhar a estrutura de `db/test-minimo-forcado.sh`)

- [ ] Cluster PG17 descartável; aplicar `schema-snapshot.sql` + foundation (`ALTER TABLE omie_products ADD COLUMN IF NOT EXISTS tipo_produto text`).
- [ ] Aplicar `20260604190000` (frente B) como base (cria coluna `minimo_forcado_manual` + RPC account-blind).
- [ ] **Semear 11 cenários** (cada SKU: `sku_parametros` habilitado+automatica, `ponto_pedido=100`, `estoque_maximo=110`; `sku_estoque_atual.estoque_fisico=90` ≤ pp → precisa 10 (=110-100... ajustar p/ 10? estoque_maximo - estoque_efetivo = qtde; usar estoque_maximo=100, estoque_fisico=90 → qtde 10); `omie_products` linhas conforme a matriz com `account`/`ativo`/`descricao`/`familia`/`tipo_produto='00'` salvo 2007/2008; `familia_nao_comprada` p/ 2004/2005c; `fornecedor_habilitado_reposicao` p/ `horario_corte_pedido` não-nulo). Garantir o **fail-closed** (`:65`): ≥1 `omie_products(account='oben')` com `tipo_produto` não-nulo (os cenários já cobrem) e, p/ o 3001, ≥1 `account='colacor'`.
- [ ] Rodar `gerar_pedidos_sugeridos_ciclo('OBEN', d)` e `('COLACOR', d)` (account-blind) → copiar `pedido_compra_item`+`pedido_compra_sugerido`+retorno p/ tabelas `*_antes`.
- [ ] Aplicar a migration C (account-aware) → limpar pedidos → rodar de novo → tabelas `*_depois`.
- [ ] **Asserts** (`RAISE EXCEPTION` / `ON_ERROR_STOP`):
  - contagem de itens por SKU antes/depois == matriz (2001..3001).
  - **multiset exato** `(sku_codigo_omie, qtde_final, valor_linha)` depois == esperado.
  - **unicidade no ciclo**: nenhum `sku` em 2 itens do mesmo `(empresa, data_ciclo)` depois.
  - por header: `num_skus = count(*) = count(DISTINCT sku)`; nenhum header sem item; `valor_total = COALESCE(sum(valor_linha),0)`.
  - **retorno da RPC** (`pedidos_gerados/skus_incluidos/valor_total_ciclo`) == agregado persistido.
  - **neutralidade**: 3 SKUs sem colisão (espelho dos 292) → rowset canônico (`sku,qtde_final,valor_linha` ordenado) antes == depois.
  - **diff mecânico**: `diff` do bloco RPC entre `20260604190000` e a migration C = exatamente a linha `AND op.account = lower(p_empresa)` (1 adição).

### Task 3: PG17 verde + CI
- [ ] `bash db/test-rpc-account-aware.sh` → todos os asserts passam.
- [ ] `heavy bun run typecheck && heavy bun run test && heavy bun run build && bun lint` (sobre o resto — sem código TS novo; deve ficar inalterado).

### Task 4: Codex adversarial no código
- [ ] `/codex` challenge na migration + harness (semente fiel? asserts pegam impl-preguiçosa? diff mecânico real? ordem de aplicação?).
- [ ] Incorporar P1/P2.

### Task 5: PR + CLAUDE.md + entrega
- [ ] Commit (migration + harness + plano), push, PR (auto-merge `--squash --auto`).
- [ ] CLAUDE.md §10: entrada da frente C (neutro-hoje/preventivo, dado do diagnóstico, runbook preflight, follow-ups registrados).
- [ ] Entregar SQL inline ao founder **com o runbook**: (1) `pg_get_functiondef` preflight; (2) re-diagnóstico de neutralidade; (3) apply em transação fora do cron. Sem deploy de edge, sem Publish.
