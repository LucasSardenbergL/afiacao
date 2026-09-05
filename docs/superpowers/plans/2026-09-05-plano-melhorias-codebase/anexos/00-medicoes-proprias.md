# Medições próprias (sessão 2026-09-05) — insumo do plano

## Repo (tamanho)
- src: 2.198 arquivos / ~295k LOC (components 96k · lib 69k · pages 48k · hooks 39k · integrations 21k, dos quais `types.ts` 20.7k)
- edges: 96 funções / ~80k LOC (`_shared` 15k). db/: 338 arquivos / 96k. scripts/: 117 / 37k. docs/: 589 arquivos (superpowers 451 = 200 plans + 248 specs; historico 96; agent 17)
- 682 migrations · 173 páginas / 180 rotas · 17 módulos no manifesto (9 money-path; `tintometrico` money-path com `testes: []`)
- 726 arquivos de teste em src (lib 328 · components 254 · hooks 86 · services 20 · __tests__ 18 · pages 14) + 65 Deno + 25 scripts
- 260 TODO/FIXME · escapes de tipo: 84 eslint-disable · 40 `as any` · 23 @ts-expect-error · 15 @ts-ignore · 17 `: any`
- 79 worktrees registradas · 3.605 commits desde 2026-05-01 · últimos 300: 121 docs · 81 fix · 57 feat · 11 test · 20 commits diretos do Lovable (WIP/update/Changes) · 2 refactor · 2 perf
- churn (desde maio): `scripts/audit-custom-migrations.sql` 264 · `types.ts` 201 · `App.tsx` 87 · `AppShell.tsx` 79 · `manifesto.ts` 66 · `AdminReposicaoCockpit.tsx` 63 · `edge-money-path-invariants.test.ts` 61 · `omie-analytics-sync` 56 · `omie-vendas-sync` 44 · `enviar-pedido-portal-sayerlack` 44
- god-files: `useRoutePlanner` 1456 · `useBundleEngine` 1369 · `useCrossSellEngine` 1227 · `financeiroService` 1211 · `useUnifiedOrder` 1053 · `TintApiContract` 993 · `useTacticalPlan` 989 · `AdminReposicaoPedidos` 969 · `AppShell` 912; edges: `omie-vendas-sync` 4.8k · `omie-analytics-sync` 3.3k · `analyze-unified-order` 3.2k · `enviar-pedido-portal-sayerlack` 2.9k · `omie-financeiro` 2.8k

## Health stack (worktree = main 9fe4e88)
- typecheck exit 0 (35s) · lint 0 errors / 74 warnings (todos `react-hooks/exhaustive-deps`; CI cita 82) · knip 0 achados (2s)
- vitest: 751 arquivos / 7.573 testes → 7.571 pass · 1 skip · **1 fail = timeout 20s** em `src/__tests__/erro-colapsado-em-vazio-gate.test.ts:107` (walker AST sobre >1.000 arquivos; 36,8s sob carga da suíte; CI da main verde → flaky-sob-carga)
- duração 820s; decomposição (soma entre workers): environment 2.184s · setup 1.017s · collect 667s · tests 456s · prepare 381s · transform 112s → **ambiente jsdom custa ~4,8× o tempo de teste**
- 429/726 arquivos de teste não tocam DOM (sem testing-library/react/document/window); 0 usam `@vitest-environment node`
- build: (ver health-build.log)

## Vitalidade — PostHog (HogQL, 90 dias, só app publicado; DEV/preview fazem opt-out)
- `$pageview`: 261 eventos / 5 usuários distintos; `$autocapture` 1.165 / 7 usuários
- rotas com pageview (pv90 · pv30 · usuários · último): `/admin/reposicao/pedidos` 131·50·1·09-04 · `/` 45·11·5·09-03 · `/admin/reposicao/sessao` 20·9·1 · `/admin/reposicao/sessao/pedidos` 20·9·1 · `/sales/new` 13·0·3·06-30 · `/sales` 10·1·2·08-14 · `/telefonia` 8·0·1·06-11 · `/meu-dia` 3·1·1·08-14 · `/sales/edit/:id` 2 · `/sales/quotes` 2 · `/rota/ligacoes` 2·0·2·06-23 · `/admin/reposicao/cadastros` 2 · `/gestao/saude-dados` 1 · `/admin/reposicao/sessao/mercado` 1 · `/admin/reposicao/sessao/parametros` 1 — **15 rotas de ~180**; zero pageview em `/financeiro/*`, `/recebimento`, `/tintometrico`, `/tarefas`, `/producao`, `/caca`, `/whatsapp`, `/admin/knowledge-base`, `/governance`
- sensores custom: `reposicao.sugestao_criada` 313 (1 usuário) · `dashboard.realtime.channel_disconnected` 584 (3 usuários — sensor ruidoso) · `dashboard.brief.priority_shown` 109 · `dashboard.viewed` 40 · `reposicao.sugestao_aprovada` 20 · `$exception` 0 linhas em 30d (ErrorBoundary → captureException; sem exceção capturada = ou zero erros ou cano mudo)
- caveat: incidente de ingestão 503 em 24/08 (analytics.md) — undercount possível; o BANCO abaixo corrobora a leitura

## Vitalidade — banco (psql-ro, 2026-09-05; stats nunca resetadas = contadores desde a criação)
- usuários: `user_roles` customer 5.664 · employee 2 · master 1; `profiles` 5.668, **4 aprovados**
- tabelas `public`: 338 · **162 jamais receberam UMA linha** (por prefixo: fin 25 · farmer 14 · fornecedor 13 · tint 10 · des 8 · omie 5 · kb 4 · cliente 4 · venda/tarefa/route/prime/picking/order 3 cada…) · 173 vazias hoje
- 180 tabelas com `created_at`: 43 com insert nos últimos 30d · 67 em 90d · **113 sem nada em 90d**
- módulos com ZERO linha desde a criação: `orders` (Loja/Afiação — o módulo-raiz do produto) · `picking_tasks/_items/_events` (offline-first, princípio nº1) · `tarefas`/`tarefa_templates`/`tarefa_eventos` · `production_orders` · `prime_*` · `loyalty_*` · `standard_processes` · `route_visits`/`route_schedule` · `visitas_agendadas` · `whatsapp_conversations/messages` (0/1) · `user_tools` (0 vivas) · 25 tabelas `fin_*` de entrada humana (`fin_dividas`, `fin_orcamento`, `fin_forecast`, `fin_antecipacoes`, `fin_fechamentos`, `fin_conciliacao`, `fin_eliminacoes_intercompany`, `fin_regime_inputs`, `fin_funding_inputs`, `fin_balanco_inputs`, `fin_kpi_tributario`, `fin_ic_matches`…)
- quase-mortos: `call_log` 20 linhas (último 06-09) · `kb_documents` 297 (último 06-13) · `whatsapp_templates` 2
- VIVOS (30d): reposição (`purchase_orders_tracking` 94 · sugestões) · financeiro-sync (`fin_movimentacoes` 3.204 · `fin_contas_receber` 718 · `fin_contas_pagar` 126 — tudo via sync Omie, nenhuma tabela de INPUT humano) · farmer (`farmer_tactical_plans` 294 · `farmer_recommendations` 13.657 · `carteira_positivacao_snapshot` 7.301) · vendas (`sales_orders` 546 · `order_items` 1.198 — sync Omie) · recebimento (`nfe_recebimentos` 16 · `nfe_efetivacao_tentativas` 14) · `whatsapp_sla_digest_log` 22 · tintométrico (sync)
- tamanho: **4.205 MB**; `tint_formula_itens` 1.099 MB (3,48M linhas; 223M inserts / 213M deletes acumulados; 1,86M inserts/30d) · `tint_formulas` 992 MB · `tint_staging_formulas` 320 · `tint_staging_formula_itens` 267 · `tint_staging_skus` 73 · `tint_staging_bases` 29 → **tint_* ≈ 2,8 GB (67%)**; `radar_empresas` 316 MB (526k) · `health_score_history` 236 MB (1,05M; 398k/30d) · `priority_score_log` 210 MB (1,04M; 398k/30d) → logs de score 446 MB sem retenção · `tint_sync_runs` 63 MB (81k) · `tint_sync_errors` 47 MB (37,7k; 20k/30d) · `sales_orders` 48 MB · `fin_audit_log` 37 MB (1.140 linhas → linhas gigantes)
- bloat: `tint_formula_itens` 234k dead tuples (autovacuum 09-04) · `tint_staging_formula_itens` 55k (08-13) · `tint_staging_skus` 37k
- crons: **93 jobs (92 ativos)**; 29.918 execuções/7d, 2 falhas; `call-log-missed-backstop` **10.080×/7d (a cada minuto)** para `call_log` com 20 linhas · `analytics-outbox-drain`, `tint-watchdog-corante-5min`, `sayerlack-portal-watchdog`, `afiacao-os-sync` 2.016× cada · `vendas-sync-continuacao-6min` 1.680 · `atp-reconciliar`/`pedidos-programados-watchdog`/`fin-sync-*` 1.008 · tempo total: `tint-watchdog-fase5-6h` 39,1 min/7d (o mais pesado) · `data-health-watchdog` 4,2 · `net._http_response` 7d: 245, todos 200
- qualidade de dado: `sales_price_history` tem 5 linhas com `created_at` = **2120-10-25**
- `_quarantine_omie_clientes_20260722` ainda existe (6.909 linhas) — quarentena concluída em 27/07 sem consumidor dormente

## Issues abertas relevantes
- cluster "merge ≠ produção": #2147 (sync-reprocess sem prova) · #2141 · #2140 (`omie-vendas-sync` serve bundle VELHO com 3 commits money-path fora do ar) · #2139 (migration mergeada não aplicada; `schema_migrations` não é oráculo) · #2138 · #2129 (chip renasce a cada 6h: edge sem via passiva = SEM_PROVA para sempre) · #2082 · #2072
- Lovable commit direto na main: #1686 (reversão provada) · #1109 (path sensível) · 20 commits diretos nos últimos 300
- produto: #624 (reposição, transposição de giro) · #56 (adoção Dashboard V3) · GOAL #1696 (indicadores por BU)
- PRs abertos: #2158 (CLAUDE.md), #2157 draft (reposição múltiplo embalagem), #2154 (CHECK fator), #2093 (db/*.sh no shellcheck)

## Superfície × uso real (manifesto × PostHog 90d × banco 30/90d)
| módulo | LOC src | testes | sinal humano 90d | veredito |
|---|---|---|---|---|
| plataforma (shell/auth/settings/docs/ai-ops) | 44.6k | 113 | infra | manter |
| reposicao | 32.0k | 134 | ✅ 131 pv `/admin/reposicao/pedidos`, sugestões 313, `purchase_orders_tracking` 94/30d | **núcleo vivo** |
| farmer-inteligencia | 29.8k | 148 | 🟡 `/meu-dia` 3 pv; planos táticos 294/30d e recomendações 13,6k/30d são CRON | vivo por automação, adoção humana fraca |
| financeiro | 23.2k | 61 | 🟡 sync Omie vivo (CR/CP/mov); **0 pageview em `/financeiro/*`**; 25 tabelas `fin_*` de input humano jamais escritas (dívidas, orçamento, forecast, antecipação, fechamento, conciliação, intercompany, regime, funding, balanço) | telas de leitura: verificar; telas de INPUT: dormentes |
| vendas | 18.8k | 91 | 🟡 `/sales` 10 pv (último 08-14), `/sales/new` 13 (último 06-30); `sales_orders` 546/30d é sync | humano raro |
| telefonia-whatsapp-rota | 14.2k | 70 | ❌ `/telefonia` 8 pv (último 06-11); `call_log` 20 linhas; `whatsapp_*` 0/1; `route_visits` 0 | dormente |
| loja-afiacao (cliente) | 10.8k | 19 | ❌ `orders` 0 linhas desde a criação; `user_tools` 0; loyalty/gamification 0 | **nunca usado** |
| governanca | 10.7k | 29 | ❌ `/gestao/saude-dados` 1 pv | dormente (exceto sensores) |
| admin-crm | 6.7k | 6 | ❌ | dormente |
| tintometrico | 6.0k | 12 | 🟡 sync massivo (2,8 GB), 0 pv nas telas | motor vivo, tela morta |
| knowledge-base | 5.3k | 15 | ❌ `kb_documents` último 06-13 | dormente |
| estoque-recebimento | 4.6k | 6 | 🟡 `nfe_recebimentos` 16/30d (import cron + 14 tentativas de efetivação); `picking_*` 0 linhas desde a criação | recebimento talvez vivo; picking **nunca usado** |
| tarefas | 3.8k | 8 | ❌ 0 linhas desde a criação | nunca usado |
| prime | 2.4k | 1 | ❌ 0 linhas | nunca usado |
| caca | 1.6k | 11 | ❌ | dormente |
| producao | 1.0k | 0 | ❌ `production_orders` 0 | nunca usado |
→ ~45–55k LOC de `src` (15–19%) + tabelas + crons + edges sustentam módulos SEM sinal humano em 90 dias; o núcleo vivo é reposição (+ farmer/financeiro por automação).
