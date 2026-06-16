# Sub-PR E — Saúde da Carteira (observabilidade/confiabilidade) — Design

> **Status:** decidido por mim + codex consult (2026-05-25). Direção: a próxima entrega é confiabilidade (Codex), não expansão de superfície. Net-new, zero-colisão (carteira é "minha", recém-entregue), backlog §10 drenado.
> **Branch:** `feat/carteira-saude` (a partir de `main`).

## Problema
O programa Carteira-Omie (A+B+D) acabou de subir: cron-pesado, business-critical e **silenciosamente degradável** — nada na UI diz se está funcionando. Falhas invisíveis: crons (`carteira-rebuild-nightly`, `scoring-recalc-batch-nightly`, `visit-score-recalc-batch-nightly`, `carteira-positivacao-snapshot-mensal`) falhando calado; `carteira_assignments.last_synced_at` envelhecendo (o spec da carteira já queria um monitor ">48h"); score coverage derivando (deveria ser 1 linha/cliente = tamanho da carteira). Hoje só dá pra saber rodando SQL na mão.

## Decisão (anti-over-build, Codex)
**Um painel read-only de SEMÁFORO operacional** (verde/amarelo/vermelho + limiar + contagem afetada + próxima ação), **não** um dashboard de gráficos. Dentro da página existente `/admin/analytics-sync` (`AdminAnalyticsSync`), como um card no topo — não cria área nova.

## Sinais MVP (rankeados pelo Codex)
1. **Saúde dos crons** — pros 4 jobs da carteira: último run, status, idade, última mensagem de erro. Pega a maior classe de falha silenciosa. Fonte: `cron.job` × `cron.job_run_details`.
2. **Frescor do sync** — `max(carteira_assignments.last_synced_at)`, idade, contagem stale/null; **vermelho se >48h**. (Deferido no spec da carteira — agora entregue.)
3. **Cobertura de score** — `count(carteira_assignments)` vs `count(distinct customer_user_id)` em `farmer_client_scores` e `customer_visit_scores`. Pega "sugestões/positivação vazias ou tortas" antes do usuário ver.

**Adiado de propósito:** `order_date_kpi` coverage (detalhe menor pós-backfill); positivação por dono (KPI já vive no fluxo do vendedor); **"clientes não-vinculados"** (semântica ambígua em `omie_clientes.user_id` — não shipar número errado; vira item futuro quando a definição estiver clara).

## Arquitetura
- **RPC `get_carteira_saude()`** `SECURITY DEFINER` (gate master/staff via `has_role`; sem param). Lê `cron.job`×`cron.job_run_details` (precisa de DEFINER — staff não lê schema `cron`; as views `v_cron_jobs_*` existentes são `security_invoker=on` e não servem pra UI), `carteira_assignments`, `farmer_client_scores`, `customer_visit_scores`. Retorna jsonb com os 3 sinais (dados crus — sem decisão de cor no SQL).
- **Helper puro `src/lib/carteira-saude/status.ts` (TDD):** `statusFor*(...)` → `{ nivel: 'green'|'yellow'|'red', acao: string }` por sinal (a regra de limiar/cor vive aqui, testável; o SQL só dá os números).
- **Hook `useCarteiraSaude()`** chama a RPC, aplica o helper.
- **`CarteiraSaudePanel.tsx`** — card semáforo (dot colorido + label + detalhe + próxima ação por check). Montado no topo do `AdminAnalyticsSync`.

## Limiares (no helper, testáveis)
- **Cron:** `red` se último status = `failed`/`failure`, ou idade > 2× intervalo esperado (nightly→48h; mensal→sem alerta de idade no dia-a-dia); `yellow` se nunca rodou; `green` se sucesso recente. Ação no red: "ver logs / reinvocar no Lovable".
- **Sync:** `red` se idade `>48h` OU `stale/null > 0`; `yellow` 24–48h; `green` `<24h`. Ação: "rodar carteira-rebuild".
- **Score coverage:** `red` se `fcs_clientes != carteira` ou `cvs_clientes != carteira`; `green` se iguais. Ação: "rodar calculate-scores + drain de visit".

## Risco (Codex) + mitigação
Dashboard passivo que ninguém abre → **checklist operacional acionável**, não analytics. Sem tendências/gráficos/leaderboard. Próxima ação humana em cada check. (Alerta proativo no topo da área de sync se algo vermelho = follow-up; v1 entrega o painel.)

## Rollout
1. SQL Editor: migration com a RPC `get_carteira_saude()`.
2. Frontend (helper+hook+painel+placement) via PR/CI.
3. Validar no app `/admin/analytics-sync` (master).

## TDD
Helper `status.ts` 100% TDD (limiares). RPC validada via SQL (números batem com queries manuais).
