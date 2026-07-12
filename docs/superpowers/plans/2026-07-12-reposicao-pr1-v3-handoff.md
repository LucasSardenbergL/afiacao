# Handoff — re-implementar o PR1 v3 (reconciliação de PO excluído no Omie)

> Briefing determinístico para uma SESSÃO NOVA. Money-path (reposição). A sessão anterior fez diagnóstico → design → execução v1 → Codex challenge (bloqueou) → design v3 corrigido. Esta sessão RE-IMPLEMENTA o PR1 com a arquitetura corrigida.

## Leia primeiro (nesta ordem)
1. `docs/superpowers/specs/2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md` — o design. §3b tem os 6 P1 do Codex; §4/§5/§8/§12 já descrevem a arquitetura v3 (publicação diferida atômica). **⚠️ Este arquivo pode estar UNCOMMITTED** (a sessão anterior não conseguiu commitar por indisponibilidade do classificador) — confira `git status`; se uncommitted, commite antes.
2. `docs/agent/reposicao.md` + `docs/agent/money-path.md` — invariantes do domínio.
3. Este handoff.

## O problema (resumo)
PO excluído direto no Omie → o `pedido_compra_sugerido` segue `disparado` → a CTE `em_transito` do motor (`gerar_pedidos_sugeridos_ciclo`, migration `20260708171049:85`) re-soma as unidades por 7d → dupla contagem fantasma → o item some do cockpit. Correção pontual do caso #1115 já aplicada (pedido 1046 → `cancelado`). Este é o fix SISTÊMICO.

**Abordagem escolhida (Opção 1):** reconciliar — detectar o PO excluído e cancelar o pedido; o motor fica INTOCADO (o `em_transito` ramo A já exclui `cancelado`). A prova de exclusão é por **consulta direta por ID** (`ConsultarPedCompra` por `nCodPed`, já usada em `disparar-pedidos-aprovados:1047`), NÃO por ausência numa busca filtrada (o Codex mostrou que previsão editada some da busca sem exclusão → falso-positivo). Fusão 2+3 (fonte única no motor) = v2 futura.

**PR1 = só a INFRA de run** (não muta pedido, não toca o motor). PR2 = candidatos + prova por ID (dry-run). PR3 = mutação. PR4 = UI.

## ⚠️ Estado do git ao receber este handoff
O branch tem 4 commits da execução v1 do PR1 que o Codex **BLOQUEOU** (falhas estruturais — não são código a aproveitar):
- `7ffd2d84` Task 1 (migration tabela+colunas+PG17)
- `3ab7fce7` + `c3f50858` Task 2 (helper TS computeVolumeOk + espelho + gate paridade) — **OBSOLETO na v3** (volume_ok vira SQL na RPC)
- `9b859eeb` Task 3 (edge carimba last_seen no upsert) — **ERRADO** (publica o sinal antes do run ser válido)

**Os testes v1 PASSAM (suíte exit 0), mas verde ≠ correto:** são unitários (helper, paridade) e NÃO pegam as falhas estruturais. Não confie nos testes v1.

**Estratégia de git recomendada (NÃO-destrutiva — evita `reset --hard`, que o guard bloqueia e é arriscado):** remova os arquivos v1 por caminho e reverta os modificados ao estado do plano (`2d0ec3a2`), num commit:
```bash
git rm supabase/migrations/20260711143616_reposicao_pedidos_compra_run.sql \
       db/test-reposicao-pedidos-compra-run.sh \
       src/lib/reposicao/volume-run.ts src/lib/reposicao/volume-run.test.ts \
       supabase/functions/_shared/reposicao-volume-run.ts
git checkout 2d0ec3a2 -- supabase/functions/omie-sync-pedidos-compra/index.ts \
                         src/__tests__/edge-money-path-invariants.test.ts
git commit -m "revert(reposicao): remove código v1 do PR1 bloqueado pelo Codex (re-implementa v3)"
```
Isso deixa o design v3 + este briefing (já commitados) intactos e o working tree limpo p/ a v3. (Os 4 commits v1 `7ffd2d84..9b859eeb` seguem no histórico do branch, mas o auto-merge SQUASHA — o estado final é limpo. Confirme com `git status` e `git log --oneline` antes de re-implementar.)

## Os 6 P1 do Codex que a v3 DEVE fechar (e o PG17 falsificar)
1. **Sinal publicado cedo** — não carimbar `last_seen` durante o upsert; publicar só no fim limpo.
2. **Run filtrado por fornecedor** envenena — não publicar quando `fornecedorCodigo` presente.
3. **`gravarRunCompleto` não fail-closed** — a cadência (`marcarCompletoOk`) só avança se a publicação teve sucesso.
4. **Concorrência** — advisory lock por empresa cobrindo marcador + `last_seen` no mesmo commit.
5. **`volume_ok` autoenvenena** — baseline só de runs `status='ok' AND ids_distintos>0 AND volume_ok IS NOT FALSE`; `baseline<=0 → volume_ok=null` (o `[0,0,0]→true` é o bug canário).
6. **Base de verdade forjável** — RLS: INSERT/UPDATE da `reposicao_pedidos_compra_run` NEGADOS a authenticated/anon; só service_role/RPC SECURITY DEFINER escreve.

## Tasks da v3 (reescreva o plano conforme o design §5)
- **Task 1 — Migration:** tabela `reposicao_pedidos_compra_run` (RLS SELECT staff via `pode_ver_carteira_completa`; escrita service_role-only) + colunas `last_seen_pedidos_full_run_id/at` em `purchase_orders_tracking` + **RPC `reposicao_publicar_run_completo(p_empresa, p_run_id uuid, p_janela_de date, p_janela_ate date, p_ids bigint[])`** (SECURITY DEFINER, service_role-only, REVOKE authenticated; numa transação: advisory_xact_lock por empresa → computa volume_ok do baseline robusto → INSERT marcador → UPDATE last_seen dos POs em `p_ids`). **PG17 falsificando os 6 P1** (em especial: RLS INSERT authenticated deve FALHAR; volume_ok `[0,0,0]`; publicação atômica; lock).
- **Task 2 — Edge `omie-sync-pedidos-compra`:** coleta `idsVistos` (Set de nCodPed) durante o run; **NÃO carimba no upsert**; no fim LIMPO e não-filtrado (`fim && !abortado && s.erros===0 && modo==='completo' && !fornecedorCodigo`) chama `reposicao_publicar_run_completo` 1× passando `[...idsVistos]` + a janela ISO (`parseBRDateOnly(dataDe/dataAte)`, não CURRENT_DATE); `marcarCompletoOk` (cadência) só roda se a RPC retornar sucesso. `deno check` + `heavy bun run typecheck`.

Nota: a v3 NÃO tem o helper TS `computeVolumeOk` (a lógica vira SQL na RPC, testada no PG17). Se o reset não removeu `src/lib/reposicao/volume-run.ts` e o espelho, apague-os + remova o `describe` de paridade em `src/__tests__/edge-money-path-invariants.test.ts`.

## Rito obrigatório (money-path)
- `prove-sql-money-path` (PG17 + falsificação) na Task 1 — os 6 P1 são os casos de falsificação.
- `deno check` + `heavy bun run typecheck` + `heavy bun run test` antes de entregar.
- **Novo Codex challenge no diff da v3** (`scripts/codex-async.sh -r xhigh` em background) — é money-path, e a v1 já foi bloqueada uma vez; provar que os 6 P1 fecharam.
- PRs pequenos; auto-merge quando `validate` passa; DRAFT para segurar.
- Registrar a entrega em `docs/historico/` (não engordar o CLAUDE.md).

## Caso de aceitação (do dado real, prod)
- Fantasma latente confirmado no diagnóstico: pedido `409` / PO Omie `#1073` (`CRIADO` congelado ~4d, fora da janela 7d). O #1115 (pedido 1046) já foi cancelado manual.
- Vínculo: `pedido_compra_sugerido.omie_pedido_compra_id`(text) = `purchase_orders_tracking.omie_codigo_pedido`(bigint)::text.
- `psql-ro`: `~/.config/afiacao/psql-ro` (role claude_ro, read-only). Escrita só via SQL Editor do Lovable (founder cola; skill `lovable-db-operator`).

## Coordenação
Nenhuma sessão paralela toca o motor/`em_transito`/reconciliação (varredura feita). O worktree `nl-9245lt` é omie-vendas-sync (mesmo SKU, trabalho diferente). Migration mais recente ao iniciar: `20260710012337` (gere timestamp > isso, confira colisão com `origin/main`).
