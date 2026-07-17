# Handoff — PR-2: religamento da demanda de insumos + fix #10

> Briefing determinístico para uma SESSÃO NOVA. Confira cada bloco por comando (não confie de memória). Contexto completo no spec — leia-o primeiro.

## 1. Objetivo desta sessão (UMA entrega)

**Executar o plano `docs/superpowers/plans/2026-07-11-reposicao-pr2-religamento.md`** (subagent-driven) e entregar o **PR-2 mergeado e provado**: religar as 4 views estatísticas na `v_sku_demanda_efetiva` (PR-1) + corrigir o furo #10. Resultado verificável: `BASE PARA TINGIMIX` (e os 23 insumos) passam a ser incluídos por `gerar_pedidos_sugeridos_ciclo('OBEN')` quando o estoque cai ao ponto. Design e plano JÁ FEITOS — não refazer. **Escopo além disso (V3, PR-3) = outra sessão.**

## 2. Estado na main (verificado 2026-07-11)

- `origin/main`: **e5bb5fb7**. PRs mergeados relevantes:
  - **#1291** — PR-1: fonte de demanda via BOM (`db/reposicao-demanda-insumos-bom.sql`: as 4 views `v_pcp_malha_oben*` + `v_sku_demanda_efetiva`). **INERTE** (não religou nada).
  - **#1292** — `security_invoker` nas 5 views de consolidação-demanda (P0 RLS). ⚠️ **Isto tocou as views que o PR-2 vai recriar** — parta do `pg_get_viewdef` ATUAL da prod, não do repo.
- ⚠️ **PR-1 NÃO foi aplicado no banco ainda** — `SELECT count(*) FROM pg_views WHERE viewname='v_sku_demanda_efetiva'` = 0 em prod. **Pré-requisito do apply do PR-2.** O apply é do founder (SQL Editor) via `docs/handoff/2026-07-09-pr1-bom-insumos-apply.md`. O PG17 aplica PR-1+PR-2 localmente, então dá para DESENVOLVER e PROVAR o PR-2 sem o apply — só o apply em prod é ordenado (PR-1 antes).

## 3. Arquivos/funções-chave (caminhos exatos)

- **LER 1º:** `docs/superpowers/specs/2026-07-11-reposicao-pr2-religamento-criticidade-design.md` (o design).
- **O PLANO JÁ ESTÁ ESCRITO:** `docs/superpowers/plans/2026-07-11-reposicao-pr2-religamento.md` — 5 tasks (pré-flight → fix #10 → religar 4 views → harness PG17 → performance → Codex+handoff). A sessão nova **executa** este plano (subagent-driven-development), NÃO refaz o brainstorming nem o writing-plans.
- `db/reposicao-demanda-insumos-bom.sql` (PR-1) — contém `v_sku_demanda_efetiva`. **Fix #10 aqui:** no ramo de consumo (2ª metade do UNION ALL) adicionar `AND v.quantidade > 0` (devolução de tingidor não recompõe componente).
- As **4 views a religar** (trocar só `FROM v_venda_items_history_efetivo` → `FROM v_sku_demanda_efetiva`): `v_sku_demanda_estatisticas`, `v_sku_sigma_demanda`, `v_sku_demanda_rajada`, `v_sku_candidatos_primeira_compra`. Pré-flight `pg_get_viewdef` de cada (preservar ordem de colunas + `security_invoker=true` que o #1292 aplicou).
- **Padrão de religamento:** `db/reposicao-consolidacao-demanda.sql` (a consolidação fez exatamente isto — trocar o FROM, alias remapeado).
- Docs a ler: `docs/agent/database.md` §4 (security_invoker/RLS), `docs/agent/money-path.md`, `docs/agent/reposicao.md`.

## 4. Decisões já tomadas (NÃO re-litigar)

- **V3 automático ABANDONADO** — Codex challenge do design achou 14 furos (Pareto quebra em população pequena, `valor_consumo` mistura venda+consumo, SKU-ambos insolúvel, C invertido, cardinalidade 112×, cross-company, proxy temporal). Reverter = reabrir os 14 furos. Detalhe no spec §7.
- **Criticidade dos ~5 insumos caros = curadoria humana** (`minimo_forcado_manual`, que o motor já honra) + visibilidade. Não há código de criticidade no PR-2.
- **Abordagem A** (explodir a ficha) — PR-1 mergeado.
- A `v_sku_classificacao_abc_xyz`, `v_sku_parametros_sugeridos`, a função de aplicação e o motor ficam **INTOCADOS** (insumo cai em classe C, aceito).

## 5. Validações a rodar (a prova da entrega — money-path)

- **`prove-sql-money-path`** (PG17 aplicando PR-1 + PR-2, com falsificação):
  - religamento: insumo (BASE) ganha `demanda_total_90d`/`demanda_media_diaria` > 0;
  - **graduação → cockpit** (teste-fim): estoque do BASE < ponto → `gerar_pedidos_sugeridos_ciclo('OBEN')` inclui o BASE; acima, não;
  - **fix #10 (falsificar):** venda de pai com `quantidade<0` não gera consumo negativo; remover o guard → vermelho;
  - **não-regressão:** `v_sku_classificacao_abc_xyz` idêntica antes/depois (`EXCEPT ALL` old×new);
  - ordem de colunas + `security_invoker=true` preservados nas 4 views.
- **Performance (obrigatório, furo #14):** `EXPLAIN (ANALYZE, BUFFERS)` sob `SET ROLE authenticated` + GUC do JWT + `statement_timeout='8s'` nas 4 views + `v_sku_parametros_sugeridos` + candidatos. Exigir folga (p95 < 4s). Se estourar → **materializar antes do fan-out** (fato privado grão `empresa×sku×data×NF`, `qtde_direta`/`qtde_consumo`/`valor` separados). `psql-ro` tem BYPASSRLS e NÃO prova o timeout — usar `SET ROLE authenticated`.
- **Codex challenge do SQL** (`scripts/codex-async.sh` em background).
- **Pós-apply (psql-ro):** BASE com `ponto_pedido` preenchido; TINGIMIX aparece com estoque ≤ ponto; classe dos produtos idêntica.

## 6. Pendências do founder

- 🟣 **SQL Editor:** aplicar o **PR-1** (`db/reposicao-demanda-insumos-bom.sql`) ANTES de aplicar o PR-2 — handoff `docs/handoff/2026-07-09-pr1-bom-insumos-apply.md`.
- 🖱️ Chip aberto (não urgente): "Limpar cadastro duplicado PRD03688 no Omie" (`task_0399980e`) — dívida de cadastro Omie; impacto de demanda zero.
- ✅ Dívida do `security_invoker` em `v_venda_items_history_efetivo`: **FECHADA** pelo #1292 (não precisa mais).

## 7. Abertura da sessão nova

- `bun run wt reposicao-pr2` (worktree NOVO a partir da main atual `e5bb5fb7` — NÃO reusar o worktree `tingimix-item-visibility-28df07`, que é a sessão que gerou este handoff).
- O spec está na branch `claude/reposicao-pr2-criticidade-insumos` no origin — `git cherry-pick d623eb6f` para a branch nova, ou copiar o arquivo do spec.
- 1ª mensagem: colar este briefing + "executar o plano `docs/superpowers/plans/2026-07-11-reposicao-pr2-religamento.md` com subagent-driven-development (o design e o plano já estão prontos; comece pela Task 0)".
