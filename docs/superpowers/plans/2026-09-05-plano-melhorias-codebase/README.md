# Plano de melhorias — Afiação (varredura completa de 2026-09-05)

> **Status: proposta** — aguarda decisão do founder nos itens marcados 🧭. Base: `main` em `9fe4e88` (worktree `intelligent-yalow-39d4e7`).
> Gerado a partir de **8 auditorias read-only por eixo** (frontend · domínio/lib · edges · banco · tooling/CI · testes · docs/backlog herdado · segurança) + **medições próprias** de uso (PostHog/HogQL), banco (`psql-ro`) e health stack. Relatórios íntegros em [`anexos/`](anexos/).
> Priorização: **score = (Impacto + Risco) × (6 − Esforço)**, cada eixo em 1–5 (skill `engineering:tech-debt`). Precisão > recall: cada achado tem evidência `arquivo:linha` e foi confirmado contra o código de hoje (o que já estava entregue foi descartado, com motivo, nos anexos).

## TL;DR

- **O código está mecanicamente saudável** (typecheck 0 · lint 0 erros · knip 0 · 7.571/7.572 testes · build limpo) e **a fundação de segurança está de pé** (336/336 tabelas com RLS, 703 policies, 0 achados P0/P1). O problema não é qualidade de linha — é **desproporção**: ~295k LOC em `src`, 173 páginas, 96 edges, 338 tabelas e 93 crons para **5 usuários ativos em 90 dias e 15 rotas com alguma visita**.
- **Seis classes de risco** concentram quase todo o valor: (R1) merge ≠ produção · (R2) verde por ausência de sinal · (R3) superfície sem uso · (R4) motores de decisão presos em hooks/monólitos sem teste · (R5) duplicação sem canônico · (R6) custo invisível do banco.
- **60 itens**, 22 com esforço 1 (um PR pequeno cada) e 49 com esforço ≤2. A **Fase 0 (21 itens, ~2 semanas)** fecha os **16 P1 da revisão de 2026-07-04 que continuam abertos** e **2 telas que estão roteadas sobre tabela/RPC inexistente em produção** (confirmado via `psql-ro`).
- **A maior alavanca não é código**: é a triagem de superfície (M-41), que só o founder pode decidir — módulos com **zero sinal humano** (Loja/Afiação com `orders` = 0 linhas desde a criação, Tarefas, Picking, Produção, Prime, Loyalty, WhatsApp, Rota, 25 tabelas `fin_*` de input jamais escritas) somam ~45–55k LOC de `src`, 162 tabelas e dezenas de crons — e continuam recebendo correções.
- §8 traz os **KPIs** que dizem se o plano funcionou.

## 1. Como foi feito (e o que este plano NÃO é)

- **8 subagentes read-only** (modelo Fable), um por eixo, cada um obrigado a: ler `CLAUDE.md` + doc de domínio antes; confirmar que a lacuna existe HOJE (`grep`/`git log -S`); citar `arquivo:linha`; devolver 8–15 achados fortes em vez de 40 fracos; e listar o que **descartou** com motivo. Os relatórios estão íntegros em `anexos/relatorio-*.md`.
- **Medições próprias** (`anexos/00-medicoes-proprias.md`): health stack completo com `heavy`; HogQL read-only (pageviews e eventos por rota, 90 dias); `psql-ro` (usuários por papel, atividade por tabela em 30/90 dias, tamanho e bloat, crons vivos e custo por job); LOC e testes por módulo do manifesto.
- **Calibrações feitas depois dos relatórios** (todas contra prod, read-only): os 3 objetos fantasma **não existem** (M-06); `recurring_schedules` tem 0 linhas (E03 das edges cai para código morto); a tabela de quarentena **tem RLS** em prod (o "sem RLS" era artefato do snapshot do bot — sintoma do M-27); `wa_owner_efetivo` **é** executável por `authenticated`; das 9 funções SECDEF executáveis por `anon`, 8 são *trigger functions* e a 9ª é pública por desenho.
- **Não é**: roadmap de produto; repetição da auditoria de UX (20/20 entregue, `docs/ux-audit/`) nem das revisões de julho; e **não toca `supabase/migrations/`** (imutável por regra).

## 2. Diagnóstico

### 2.1 Baseline mecânica (nesta worktree, `heavy`)

| Check | Resultado | Nota |
|---|---|---|
| typecheck (2 `tsc`) | 0 erros · 35s | |
| lint | 0 erros · 74 warnings | todos `react-hooks/exhaustive-deps`; o `ci.yml` cita 82 (número morto) |
| knip | 0 achados | |
| vitest | 751 arquivos · 7.573 testes · **7.571 ✅ · 1 skip · 1 ❌** | ❌ = timeout de 20s no gate AST `erro-colapsado-em-vazio` (37s sob carga); a main está verde → custo, não regressão (M-25) |
| duração da suíte | **820s** | `environment` (jsdom) 2.184s vs `tests` 456s — 429–447 arquivos puros rodam em jsdom sem precisar (M-24) |
| build | exit 0 · 941s · 337 chunks · 6,4 MB / **1,94 MB gzip** | 0 avisos; maiores: `vendor-elevenlabs` 119 KB gz, `vendor-charts` 114 KB, `WebRTCCallContext` 62 KB |
| CI (parede) | ≈7,5 min | Tests 49% · hooks/falsificação/evals 26%; **12,5% de falha** nos 56 runs recentes; **36% das falhas em 60 dias são gates de 0–2s** que ninguém roda antes do push (M-23) |

### 2.2 Uso real × superfície (o dado que reordena tudo)

**Quem usa:** `user_roles` = 1 master · 2 employees · 5.664 customers (cadastros importados); `profiles` aprovados = **4**. PostHog em 90 dias: `$pageview` 261 eventos / **5 usuários distintos**; **15 rotas** de ~180 com alguma visita — e **zero** em `/financeiro/*`, `/recebimento`, `/tintometrico`, `/tarefas`, `/producao`, `/caca`, `/whatsapp`, `/admin/knowledge-base`, `/governance`. Caveat: houve incidente de ingestão em 24/08 (undercount possível); por isso o banco foi usado como segunda testemunha — e confirma.

**O que o banco diz (contadores desde a criação, nunca resetados):** 338 tabelas em `public`; **162 jamais receberam uma linha**; das 180 com `created_at`, só **43 tiveram insert nos últimos 30 dias** e 113 não tiveram nada em 90. Tabelas com **0 linhas desde a criação**: `orders` (Loja/Afiação — o módulo-raiz do produto), `picking_tasks/_items/_events` (offline-first, princípio nº1 do briefing), `tarefas`, `production_orders`, `prime_*`, `loyalty_*`, `standard_processes`, `route_visits`, `visitas_agendadas`, `whatsapp_conversations/messages`, e **25 tabelas `fin_*` de input humano** (dívidas, orçamento, forecast, antecipações, fechamentos, conciliação, intercompany, regime, funding, balanço). O que está vivo é **sync** (Omie/Sayerlack/tint) e **reposição**.

| Módulo (manifesto) | LOC `src` | Testes | Sinal humano em 90 dias | Veredito |
|---|---|---|---|---|
| plataforma (shell/auth/settings/docs) | 44,6k | 113 | infra | manter |
| reposicao | 32,0k | 134 | ✅ 131 pv em `/admin/reposicao/pedidos`; 313 sugestões; `purchase_orders_tracking` 94/30d | **núcleo vivo** |
| farmer-inteligencia | 29,8k | 148 | 🟡 `/meu-dia` 3 pv; planos táticos 294/30d e 13,6k recomendações são **cron** | vivo por automação, adoção humana fraca |
| financeiro | 23,2k | 61 | 🟡 sync vivo (`fin_movimentacoes` 3.204/30d); **0 pageview**; 25 tabelas de input jamais escritas | leitura: verificar · input: dormente |
| vendas | 18,8k | 91 | 🟡 `/sales` 10 pv (último 14/08); `sales_orders` 546/30d é sync | humano raro |
| telefonia-whatsapp-rota | 14,2k | 70 | ❌ `call_log` 20 linhas (última 09/06); `whatsapp_*` 0/1; `route_visits` 0 | dormente |
| loja-afiacao (cliente) | 10,8k | 19 | ❌ `orders` **0 linhas desde a criação** | **nunca usado** |
| governanca | 10,7k | 29 | ❌ 1 pv | dormente |
| admin-crm | 6,7k | 6 | ❌ | dormente |
| tintometrico | 6,0k | 12 | 🟡 sync de 2,8 GB; 0 pv nas telas | motor vivo, tela morta |
| knowledge-base | 5,3k | 15 | ❌ último documento 13/06 | dormente |
| estoque-recebimento | 4,6k | 6 | 🟡 `nfe_recebimentos` 16/30d (import cron + 14 efetivações); `picking_*` 0 | recebimento talvez vivo · picking nunca usado |
| tarefas | 3,8k | 8 | ❌ 0 linhas | nunca usado |
| prime | 2,4k | 1 | ❌ 0 linhas | nunca usado |
| caca | 1,6k | 11 | ❌ | dormente |
| producao | 1,0k | 0 | ❌ 0 linhas | nunca usado |

**Banco (4,2 GB):** `tint_*` = **2,8 GB (67%)** com reescrita contínua (`tint_formula_itens`: 3,5M linhas, 1,86M inserts/30d, 213M deletes acumulados, 234k dead tuples; `tint_sync_errors` 20k/30d); `health_score_history` + `priority_score_log` = **446 MB** sem retenção (+800k linhas/30d); `radar_empresas` 316 MB. **Crons:** 93 (92 ativos), 29.918 execuções/7 dias — `call-log-missed-backstop` roda **a cada minuto** (10.080×/semana) para uma tabela com 20 linhas.

### 2.3 O que cada eixo encontrou (resumo — detalhe nos anexos)

- **Frontend** (`relatorio-frontend.md`, 14 achados): aderência ao DS v3 é alta onde há adapter (`text-status-*` 2.326 usos vs 94 cores cruas; 0 `posthog.` direto; 0 toast fora do sonner), mas **as convenções sem sensor não pegaram** (`useUrlState` em 6/172 páginas, 0 `PageHeader`, 622 `queryKey` literais e 0 fábrica). 16 arquivos ≥600 linhas; os 4 motores Farmer/Rota somam 5.100 linhas em hooks com fetch manual e 0 teste co-localizado. Money-path: `CockpitDrillDown` soma total no cliente sobre `.limit(500)` e descarta `error`. `ErrorBoundary` único derruba o shell inteiro.
- **Domínio/lib** (`relatorio-dominio.md`, 15): a fabricação de zero é pontual (`margin.ts`), mas o sistêmico são os **casts**: 229 `as never` + 310 `as unknown as`; **79 dos 89** `.from/.rpc('x' as never)` apontam para nomes que `types.ts` já tipa, e **3 para objetos que não existem em prod** — foi assim que uma feature roteada sobre tabela inexistente passou no typecheck. 39 formatadores BRL, 16 `roundN`, 11 paginadores, 5 "hoje" (26 sites UTC). `queries/` ≡ `hooks/`. Fronteiras de módulo estagnadas em 230 arestas.
- **Edges** (`relatorio-edges.md`, 13): 95 edges / 64,6k LOC, **76 sem teste**; `config.toml` cobre 49/95 e não descreve o gateway real (51 `net.http_post` de cron com `x-cron-secret`, 14 gates reimplementados à mão). Sonda de versão em 40/95 — **26 edges sem prova de deploy** (9 com cron, 17 chamadas pelo browser, várias com escrita irreversível). 56 edges com `fetch`, 17 com timeout; 15 clientes Anthropic sem `timeout`/`maxRetries`; 25 wrappers Omie duplicados. O gateway Lovable/Gemini que a doc chama de "legado em uso" tem **0** edges.
- **Banco** (`relatorio-banco.md`, 13): fundação limpa (335/336 RLS no snapshot, 0 SECDEF sem `search_path`, 0 float monetário, 0 tabela sem PK). Os problemas são de **prova**: o snapshot de 05/09 foi commitado pelo **bot do Lovable** sem as 3 provas do `refresh-snapshot.sh`; o audit de migrations (4.460 linhas) foi regenerado **268×** sem nenhum resultado de prod commitado; 72 tabelas / 59 funções / 39 views em prod sem `CREATE` no repo; 116/204 FKs sem índice; 267 harnesses PG17 com bootstrap copiado.
- **Tooling/CI** (`relatorio-tooling.md`, 15): merge de PR **não dispara CI na main** (só o bot do Lovable) → 56 dispatches manuais em 30 dias; `edges:typecheck` sem `deno.lock` deu 2 mains vermelhas sem culpado; 3 lockfiles (2 fósseis); shellcheck fora do CI (#2093 vermelho há 7 dias no próprio gate); 22 majors atrasados (Vite 8 bloqueado por peers); 79 worktrees = 16,7 GB.
- **Testes** (`relatorio-testes.md`, 14): higiene boa por desenho (0 skip/only, 0 snapshot, mocks roteados por tabela). O que falta é **prova onde dói**: 270 harnesses PG17 (84k LOC) **nunca rodam no CI**; `disparar-pedidos-aprovados` (cria pedido de compra na Omie) só tem contrato de sonda; `useRoutePlanner` 0 testes; cobertura não medida; 435/466 `.test.ts` puros pagam jsdom.
- **Docs/backlog** (`relatorio-docs.md`): da revisão de 2026-07-04, **16 itens seguem abertos e 4 parciais** (tabela em §2.4). `docs/superpowers/` tem 446 arquivos, **17% referenciados**, fora de todo gate; `analytics.md` é 60% diário datado; README é o boilerplate Lovable intocado (`REPLACE_WITH_PROJECT_ID` ×3, `npm i`); contagens mortas ("119 rotas" vs 180; "30 worktrees" vs 79). Caminhos citados: 0 quebrados (o gate funciona).
- **Segurança** (`relatorio-seguranca.md`, 13): **nenhum P0/P1**. Residual: 2 policies `WITH CHECK (true)`; transcrições sem retenção; sentinela de RLS que não cobre 2º fator/receita/PII; write-guard da lente não intercepta `.rpc()`; `.env` versionado (só chaves públicas); comparação de segredo não constant-time.

### 2.4 Backlog herdado da revisão de 2026-07-04 que segue aberto (verificado no código de hoje)

| Item | Sev. | Status | Evidência | Neste plano |
|---|---|---|---|---|
| `handleFinalize` não checa `modo` — toast "efetivada" em falha | P1 | aberto | `RecebimentoConferencia.tsx:397-423`; edge devolve 200 com `success:false` | M-01 |
| `fin-ic-reconcile` sem paginação + delete-all | P1 | aberto | 0 `.range(`, `.delete()` l.267 | absorvido por M-41/M-58 (intercompany é dormente) |
| `fin-funding` filtra `status_titulo='ABERTO'` (morto) | P1 | parcial | `fin-funding:555` | M-08 |
| Rejeição em lote sem guard de status | P1 | aberto | `useCicloHoje.ts:146-155` | M-02 |
| Editor de qty grava `num_skus`, não itens | P1 | aberto | `PedidoRow.tsx:64-69` | M-03 |
| "Aprovar e disparar" descarta `precoEdits` só-preço | P1 | parcial | `useDetalhesModal.ts:231` | M-03 (mesmo PR) |
| "Faturado hoje" não filtra empresa | P1 | aberto | `useVendasZone.ts:47-52` | M-07 |
| "Gap de Margem" soma `.limit(100)` | P1 | aberto | `IntelligenceStrategicTab.tsx:34,93` | M-11 |
| Customer360 sem `deleted_at`/status, engole erro | P1 | aberto | `customer360/hooks.ts:140-146` | M-35 (gate) + PR próprio |
| `handleRestore` não trava cliente do rascunho | P1 | aberto | `UnifiedOrder.tsx:262-270` | PR próprio na Fase 0 |
| SW não cacheia `picking_task_items`/`nfe_lotes_escaneados` | P1 | aberto | `vite.config.ts:207` | condicionado a M-41 (picking) |
| `signOut` sem `queryClient.clear()` | P1 | aberto | `AuthContext.tsx:368-373` | M-10 |
| `makeCall` sobrescreve sessão SIP sem `terminate()` | P1 | aberto | `sip-client.ts:119-133` | condicionado a M-41 (telefonia) |
| Datas UTC como "hoje" (29 sítios) | sist. | parcial | `visitas/today.ts:3`, `FluxoCaixaTab:22`… | M-49 |
| Drill-down "Total" `.limit(500)` · `getAging*` → R$0 · lock TTL 5 min · `submitQuote` sem ref-guard | P2 | aberto | `CockpitDrillDown:105-141` · `financeiroService:308-313` · `useUnifiedOrder:744` | M-05 + PRs próprios |
| ux-audit: `nfe_receipt_runs`/`user_segments` em localStorage, redirect mobile, `/unified-order` | decisão | aberto desde 13/05 | `App.tsx:324,407` | §6 |

## 3. As seis classes de risco sistêmico

**R1 — Merge ≠ produção (a prova não fecha).** Oito issues abertas são "deploy pendente" (#2072, #2082, #2129, #2138, #2139, #2140, #2141, #2147); `omie-vendas-sync` serviu bundle velho com 3 commits money-path fora do ar; o snapshot do schema chegou pelo bot sem provas; o audit de migrations não tem carimbo e `schema_migrations` é fail-open; 72 tabelas em prod sem `CREATE` no repo; o CI não roda na main após merge; 26 edges não têm sonda. → **M-22, M-26, M-27, M-29, M-32, M-37.**

**R2 — Verde por ausência de sinal.** Casts `as never`/`as unknown as` desligam a checagem de coluna em 540+ sítios (M-06 passou no typecheck assim); convenções do CLAUDE.md sem sensor não aderem (`useUrlState` 6/172, `PageHeader` 0, 94 cores cruas); 14 gates de auth reimplementados por convenção; sentinela de RLS parcial; 84k LOC de harness PG17 fora do CI; `$exception` do PostHog com 0 linhas apesar de telas quebradas. → **M-28, M-31, M-35, M-39, M-40, M-53.**

**R3 — Superfície sem uso que continua custando.** 15–19% de `src`, 162 tabelas, dezenas de crons e edges sem um único sinal humano; cada um ainda recebe correções (`makeCall` SIP, cache do picking), entra no `types.ts` de 20,7k linhas, no manifesto, na suíte de 13,7 min e no CI de 7,5 min. → **M-41 (decisão), M-42, M-16, M-17, M-46, M-47.**

**R4 — Motores de decisão presos em hooks e monólitos.** 5.100 LOC de motor comercial/logístico em 4 hooks com I/O manual, testáveis só por `renderHook`; ~2,5k LOC puras dentro de 5 `index.ts` de edge que nenhum teste importa; a edge que cria pedido de compra na Omie só tem contrato de sonda. → **M-57, M-58, M-40, M-25.**

**R5 — Duplicação sem canônico (cada regra vira N correções).** 25 wrappers Omie, 22 leitores de credencial, 16 retries, 15 clientes Anthropic, 39 formatadores BRL, 16 `roundN`, 11 paginadores, 5 "hoje", 267 bootstraps de harness — #1614/#1623 já foram correções wrapper a wrapper. → **M-33, M-48, M-49, M-50, M-52, M-53.**

**R6 — Custo invisível do banco.** 2,8 GB de `tint_*` reescritos continuamente (213M deletes), 446 MB de logs de score sem retenção, 20k erros de sync/30d, 116 FKs sem índice, cron por minuto para feature morta. → **M-43, M-17, M-16, M-54, M-42.**

## 4. Lista priorizada (60 itens, score decrescente)

Legenda: **I** impacto · **R** risco de deixar como está · **E** esforço (1 = um PR pequeno; 5 = várias semanas) · **Score = (I+R)×(6−E)** · Fase 0–4 (§5). IDs `M-nn` são estáveis para referência em PR/issue.

| # | ID | Fase | Item | Eixo | I | R | E | Score | Origem |
|---|---|---|---|---|---|---|---|---|---|
| 1 | M-01 | 0 | Conferência de NF-e: `handleFinalize` mostra "efetivada" quando a edge devolve 200 com `success:false` | recebimento · money-path | 4 | 4 | 1 | **40** | ✅ #2201 · backlog 07-04 (aberto)|
| 2 | M-02 | 0 | Rejeição em lote da reposição sem guard de status (`.in("id", ids)` sem `.eq('status')`) | reposição · money-path | 4 | 3 | 1 | **35** | ✅ #2204 · backlog 07-04 (aberto)|
| 3 | M-03 | 0 | Editor de quantidade grava `num_skus` em vez dos itens do pedido | reposição · money-path | 4 | 3 | 1 | **35** | ✅ #2205 · backlog 07-04 (aberto)|
| 4 | M-04 | 0 | `margin.ts` fabrica margem negativa: `unit_price \|\| 0` (assimétrico com o custo) | vendas · money-path | 4 | 3 | 1 | **35** | ✅ #2206 · domínio A3|
| 5 | M-05 | 0 | `CockpitDrillDown` soma "Total" no cliente sobre `.limit(500)` e descarta `error` (zero fabricado) | reposição · money-path | 5 | 3 | 2 | **32** | frontend FE-02 · P2 desde 07-04 |
| 6 | M-28 | 1 | Gate `casts-stale`: 79 dos 89 `.from/.rpc('x' as never)` apontam para nomes que `types.ts` JÁ tipa — o cast desliga a checagem de coluna (foi assim que #6 passou no typecheck) | tipos | 4 | 4 | 2 | **32** | domínio A1/A15 |
| 7 | M-07 | 0 | "Faturado hoje" não filtra empresa (`companies` está na queryKey, não na query) | vendas · money-path | 3 | 3 | 1 | **30** | backlog 07-04 (aberto) |
| 8 | M-08 | 0 | `fin-funding` ainda filtra `status_titulo='ABERTO'` (valor morto; cashflow já corrigido) | financeiro · money-path | 3 | 3 | 1 | **30** | backlog 07-04 (parcial) |
| 9 | M-09 | 0 | Policies `INSERT WITH CHECK (true)` para `authenticated` em `reposicao_motor_run` e `reposicao_estoque_nao_confirmado_log` | segurança | 3 | 3 | 1 | **30** | segurança A1 · banco B09 |
| 10 | M-10 | 0 | `signOut` sem `queryClient.clear()` — cache de outro usuário sobrevive à troca de sessão | auth | 3 | 3 | 1 | **30** | backlog 07-04 (aberto) |
| 11 | M-39 | 1 | Verificar o cano `$exception` do PostHog: 0 exceções em 30 dias com telas quebradas em prod é suspeito | observabilidade | 3 | 3 | 1 | **30** | medição própria (HogQL) |
| 12 | M-06 | 0 | Telas roteadas sobre objetos que NÃO existem em prod: `fila_aplicacao_omie` + RPC `gerar_fila_aplicacao_omie` e `quality_checklists` | reposição/loja · correção | 4 | 3 | 2 | **28** | domínio A2 · banco B03 · confirmado via psql-ro |
| 13 | M-25 | 1 | Gate AST `erro-colapsado-em-vazio` custa 37s contra teto de 20s — pré-filtro textual antes do parse, sem subir teto | testes | 4 | 3 | 2 | **28** | testes A1 · única falha da rodada |
| 14 | M-27 | 1 | Snapshot de schema: regerar com `db/refresh-snapshot.sh` (3 provas) + gate `wc -l` × manifest — o snapshot de 05/09 veio pelo bot do Lovable sem provas e o manifest está em 28/08 | banco · DR | 4 | 3 | 2 | **28** | banco B01 |
| 15 | M-33 | 1 | `omie-deadline.ts` nos 3 enumeradores Omie sem teto de relógio (`omie-vendas-sync`, `omie-analytics-sync`, `omie-sync`) + `_shared/anthropic-cliente.ts` com `timeout`/`maxRetries` nas 15 edges LLM | edges · robustez | 4 | 3 | 2 | **28** | edges E01/E02 |
| 16 | M-11 | 0 | "Gap de Margem" soma `.limit(100)` de um log append-only | farmer · money-path | 3 | 2 | 1 | **25** | backlog 07-04 (aberto) |
| 17 | M-12 | 0 | `SalesProducts` lê `omie_products` com `.select('*')` sem `.range` (capa silenciosa de 1.000) | vendas | 3 | 2 | 1 | **25** | frontend FE-03 |
| 18 | M-17 | 0 | Retenção de `health_score_history` + `priority_score_log` (446 MB, +800k linhas/30d, sem expurgo) | banco | 3 | 2 | 1 | **25** | medição própria |
| 19 | M-22 | 1 | CI na main após merge — hoje só o bot do Lovable dispara `push`; 56 dispatches manuais/30d pelo `/fecho` | CI | 4 | 2 | 2 | **24** | tooling T01 |
| 20 | M-24 | 1 | vitest `environmentMatchGlobs`: `.test.ts` → node, `.test.tsx` → jsdom (+31 overrides `@vitest-environment jsdom`) | testes · perf | 4 | 2 | 2 | **24** | testes A2 · tooling T02 |
| 21 | M-26 | 1 | Sonda de versão (`versao.ts`) nas 26 edges sem sonda — 9 com cron e 17 chamadas pelo browser, inclusive escritas irreversíveis (`omie-aplicar-parametros`, `whatsapp-send*`, `omie-sync`, `enviar-push`) | deploy · edges | 4 | 2 | 2 | **24** | edges E04 · issues #2129/#2147/#2140 |
| 22 | M-30 | 1 | `ErrorBoundary` único acima de `<Routes>` — tela quebrada derruba o shell inteiro | frontend · UX | 4 | 2 | 2 | **24** | frontend FE-01 |
| 23 | M-31 | 1 | Sentinela `authz:rls:prod` não cobre `webauthn_credentials` (2º fator), `tint_formula_itens` (receita), `whatsapp_*`/`farmer_calls` (PII), `company_config` | segurança | 4 | 2 | 2 | **24** | segurança A3 |
| 24 | M-36 | 1 | LGPD: transcrições (ligação/WhatsApp/copilot) sem retenção/expurgo + payload com PII de cliente em logs de edge | LGPD | 3 | 3 | 2 | **24** | segurança A2/A8 |
| 25 | M-49 | 3 | `src/lib/money/`: `formatarBRL` canônico (39 formatadores, `null`→"—" em vez de "R$ 0,00"), `arredondar` com EPSILON (16 `roundN` locais), `hojeSP` (26 sites `toISOString().slice(0,10)` + 5 implementações de "hoje") | domínio · money-path | 3 | 3 | 2 | **24** | domínio A4/A5/A9 · backlog "datas UTC" |
| 26 | M-60 | 4 | `prime`: writer sem teste (`usePrimeAdmin.ts` 344 LOC, 14 rpc/insert; 33 asserts só na fórmula) — apenas se sair da triagem como "ativar" | testes · money-path | 3 | 3 | 2 | **24** | testes A6 |
| 27 | M-32 | 1 | Carimbo de migrations aplicadas (mesmo padrão do `authz:carimbo`) — `audit-custom-migrations.sql` (4.460 linhas) foi regenerado 268× sem nenhum resultado de prod commitado | banco · DR | 4 | 3 | 3 | **21** | banco B02 · issues #2139/#2141 |
| 28 | M-41 | 2 | 🧭 Triagem de superfície, módulo a módulo — ativar com sensor · congelar (esconder rota, manter código) · arquivar (remover código + tabelas + crons + edges): loja-afiacao (10,8k LOC, `orders` 0 linhas), telefonia/whatsapp/rota (14,2k), tarefas (3,8k), prime (2,4k), produção (1k), picking (~3k), knowledge-base (5,3k), governança (10,7k), admin-crm (6,7k), telas de INPUT do financeiro (25 tabelas `fin_*` jamais escritas) | produto · decisão do founder | 5 | 2 | 3 | **21** | medição própria (PostHog + banco + manifesto) |
| 29 | M-43 | 2 | `tint_*` = 2,8 GB (67% do banco) com reescrita contínua: 1,86M inserts/30d, 213M deletes acumulados, `tint_sync_errors` 20k/30d — delta-sync por hash em vez de rewrite; limpar staging; expurgo de `tint_sync_runs/errors` | banco · perf · custo | 4 | 3 | 3 | **21** | medição própria |
| 30 | M-58 | 4 | Edges monólitos: extrair ~2,5k LOC puras + testes Deno — começar por `disparar-pedidos-aprovados` (1.923 LOC, cria pedido na Omie, só contrato de sonda), `fin-valor-engine`, `fin-cashflow-engine` (26 fn/708 LOC), `omie-financeiro` (31 fn/767 LOC) | edges · money-path | 4 | 3 | 3 | **21** | edges E05 · testes A4 |
| 31 | M-13 | 0 | `sales_price_history` com 5 linhas datadas de 2120-10-25 | dados | 2 | 2 | 1 | **20** | medição própria (psql-ro) |
| 32 | M-14 | 0 | Lote de higiene de 1 dia: apagar `bun.lockb` + `package-lock.json`; `.env` fora do git (allowlist); `concurrency` no `ci.yml`; `tsc -p tsconfig.node.json` no typecheck; shellcheck no CI (destravar #2093 com `--exclude=SC2317`) | tooling | 3 | 1 | 1 | **20** | tooling T05/T06/T08/T14 · segurança A7/A13 |
| 33 | M-15 | 0 | `timingSafeEq` centralizado em `_shared/auth.ts` + `REVOKE EXECUTE` de `wa_owner_efetivo` (grant a `authenticated` confirmado em prod) | segurança | 2 | 2 | 1 | **20** | segurança A9/A10 · confirmado via psql-ro |
| 34 | M-16 | 0 | Crons de features sem dado: `call-log-missed-backstop` roda a cada minuto (10.080×/semana) para `call_log` com 20 linhas; watchdogs `atp-*`, `pedidos-programados-watchdog`, `tint-watchdog-corante-5min` | infra · banco | 3 | 1 | 1 | **20** | medição própria (cron.job_run_details 7d) |
| 35 | M-19 | 0 | Docs: mover `analytics.md` §6 (600 linhas de diário), `ONDA1_*`, `handoff-cost-proxy-fix.md`, `docs/handoff/*` para `docs/historico/`; trocar contagens mortas por comandos ("119 rotas"→180, "30 worktrees"→79, "32/93 edges"→95) | docs | 3 | 1 | 1 | **20** | docs D4/D9/D1-D3 |
| 36 | M-21 | 0 | Testes: preload que lança "use `bun run test`"; step `build-id-paridade` após o build (hoje é o `1 skipped`); remover tetos `15000`/`waitFor 10_000` do `priceGuard` | testes | 2 | 2 | 1 | **20** | testes A9/A10/A11 |
| 37 | M-23 | 1 | `bun run gates:rapidos` (~5s) disparado pelo `pr-collision-guard` antes do `gh pr create` — 36% das falhas de CI em 60d são gates de 0–2s | CI · DX | 4 | 1 | 2 | **20** | tooling T03 |
| 38 | M-29 | 1 | `deno.lock` para o `edges:typecheck` — único gate com rede resolve o registry ao vivo (2 mains vermelhas sem culpado em 3 semanas) | CI | 3 | 2 | 2 | **20** | tooling T04 |
| 39 | M-34 | 1 | Lint ratchet `--max-warnings 74` + `no-floating-promises` (`checkThenables`) só em services/hooks/queries | lint | 3 | 2 | 2 | **20** | tooling T07 |
| 40 | M-37 | 1 | `cron.job` capturado no snapshot/DR — runbook diz 33 crons, prod tem 93 | banco · DR | 3 | 2 | 2 | **20** | banco B08 · medição própria |
| 41 | M-42 | 2 | Dropar as tabelas jamais escritas (162) que a triagem liberar — migration reversível após `git grep` + `pg_stat` | banco | 3 | 2 | 2 | **20** | medição própria · banco B12 |
| 42 | M-45 | 2 | README humano (~80 linhas): bun, `.env.example`, PR → auto-merge → 3 deploys manuais, worktrees, `psql-ro` — hoje é boilerplate Lovable com `REPLACE_WITH_PROJECT_ID` ×3 e `npm i` | docs · onboarding | 4 | 1 | 2 | **20** | docs R1/D10 |
| 43 | M-46 | 2 | Worktrees: 79 vivas, 22 `node_modules` = 16,7 GB, 70 anteriores a setembro | infra local | 2 | 2 | 1 | **20** | tooling T09 |
| 44 | M-53 | 3 | Auth de edges via `_shared/auth.ts` (14 gates `x-cron-secret` reimplementados à mão, 6 money-path) + `config.toml` fiel ao gateway real | edges · segurança | 3 | 2 | 2 | **20** | edges E07 |
| 45 | M-56 | 3 | Ratchet de fronteiras de módulo que APERTA: baseline estagnada em 230 arestas (+10/−6 em 2 meses; farmer↔telefonia 40) e o gate aceita aresta nova por comando | arquitetura | 3 | 2 | 2 | **20** | domínio A7 |
| 46 | M-40 | 1 | Job `db-harness` no CI: `services: postgres:17`, allowlist de 8–12 harnesses money-path em PR que toca `db/`/migrations + nightly — 270 harnesses (84k LOC) hoje só rodam à mão | testes · money-path | 5 | 4 | 4 | **18** | testes A3 |
| 47 | M-51 | 3 | Parsers zod nas fronteiras `.rpc()`/`functions.invoke()` money-path (169 casts `data as X`, 0 zod) — começar por `useAplicacaoFila`, `AdminReposicaoPedidos` (disparo a fornecedor), `financeiroV2Service` | domínio · money-path | 3 | 3 | 3 | **18** | domínio A8 |
| 48 | M-59 | 4 | Dependências: 22 majors atrasados — ordem segura: minors radix/hookform → `date-fns` 4, `jsdom` 26, `react-day-picker` 9, `lucide` → `zod` 4 → `react-router` 7 → `tailwind` 4; Vite 8 BLOQUEADO pelos peers de `lovable-tagger`/`vite-plugin-pwa` | dependências | 3 | 3 | 3 | **18** | tooling T13 |
| 49 | M-35 | 1 | Gates de convenção com baseline (padrão do repo) para o que o CLAUDE.md afirma sem sensor: cores cruas (94 em 32 arquivos), `useUrlState` (6/172 páginas), `PageHeader` (0/126 `<h1>`), chaves RQ (622 literais, 0 fábrica → `@tanstack/eslint-plugin-query`), `div onClick` sem teclado (11) | frontend · convenções | 3 | 1 | 2 | **16** | frontend FE-06..09/12 |
| 50 | M-38 | 1 | `registro-execucao` nas 13 ações bilaterais (cron + clique) que hoje não registram em lado nenhum | observabilidade | 3 | 1 | 2 | **16** | edges E08 |
| 51 | M-44 | 2 | `docs/superpowers/` congelado (372/446 órfãos, 1 plan/mês) + `INDEX.md` + arquivo por trimestre; skill `lovable-deploy-verify` (984 linhas / 86 KB por invocação) fatiada | docs | 3 | 1 | 2 | **16** | docs S1/K1 |
| 52 | M-50 | 3 | Paginação PostgREST: 1 helper canônico (11 hoje, 6 fora do pin G2) + assinatura de `fetchAllPages` que elimina os 24 `as unknown as PromiseLike` | domínio | 2 | 2 | 2 | **16** | domínio A10/A11 |
| 53 | M-54 | 3 | Índices: 116/204 FKs sem índice (priorizar `tint_staging_*.sync_run_id`, `tint_formula_itens.corante_id`, `picking_events`) e 18 redundantes (7 duplicatas exatas) | banco · perf | 3 | 1 | 2 | **16** | banco B05/B06 |
| 54 | M-18 | 0 | Dropar `_quarantine_omie_clientes_20260722` (quarentena de 7 dias concluída em 27/07) | banco · higiene | 2 | 1 | 1 | **15** | banco B10 · memória 27/07 |
| 55 | M-20 | 0 | `CLAUDE.md`/`deploy.md` descrevem o gateway Lovable/Gemini como legado em uso — 0 edges usam (15 Anthropic direto) | docs | 2 | 1 | 1 | **15** | edges E10 |
| 56 | M-47 | 2 | Edges órfãs (`verify-employee`, `gmail-webhook-receiver`) e `omie-sync` (1.676 LOC, 29 `case`, sem sonda/teste/timeout/lease) — provar lado prod e aposentar/decompor | edges · higiene | 2 | 1 | 1 | **15** | edges E12/E11 |
| 57 | M-52 | 3 | Harness PG17: lib compartilhada de bootstrap (267 cópias de `initdb`/stub `auth.uid`; `safeupdate` em 1/270) | testes · db | 3 | 2 | 3 | **15** | banco B07 |
| 58 | M-55 | 3 | Camada de dados única: `queries/` ≡ `hooks/`; 73 arquivos de UI com supabase direto; `services` 0/45 com react-query — regra escrita + migração incremental | arquitetura | 3 | 2 | 3 | **15** | domínio A6 |
| 59 | M-48 | 3 | Cliente Omie compartilhado: 25 wrappers `omieCall`, 22 leitores de credencial, 16 retries, 12 `sleep`, 9 conversores de data → `_shared/omie-cliente.ts` (timeout, retry, paginação até página vazia) | edges · duplicação | 4 | 2 | 4 | **12** | edges E06 · #1614/#1623 foram correções wrapper a wrapper |
| 60 | M-57 | 4 | Extrair os 4 motores de decisão para `src/lib/*/motor.ts` puro + testes: `useRoutePlanner` (1.456 LOC, 30 `useState`, 0 testes), `useBundleEngine` (`calculateBundles` 1.096 LOC num `useCallback`), `useCrossSellEngine` (1.227), `useTacticalPlan` (989) | frontend · arquitetura | 3 | 3 | 4 | **12** | frontend FE-04/05 · testes A5 |

## 5. Plano faseado (para rodar junto com o trabalho de feature)

Regras de execução: **1 item = 1 PR** (auto-merge no CI verde), com o ritual `/codex` em todo item money-path e a sonda/`versao.ts` em toda edge tocada. A Fase 0 cabe em ~2 semanas de trabalho assistido; as Fases 1–3 rodam em paralelo com features (um item por sessão); a Fase 4 é contínua. Dentro de cada fase, a ordem é o score.

### Fase 0 — Correções P1 e quick wins (21 itens · score somado 550)

- ✅ #2201 · **M-01** (40) — Conferência de NF-e: `handleFinalize` mostra "efetivada" quando a edge devolve 200 com `success:false`
  - Evidência: `RecebimentoConferencia.tsx:397-423` só lê `res.error`; `omie-nfe-recebimento:537,642` · Origem: backlog 07-04 (aberto)
  - Ação: Ler `success`/`modo` e degradar para erro visível; edge passa a responder ≠200 na falha. Teste de falsificação.
- ✅ #2204 · **M-02** (35) — Rejeição em lote da reposição sem guard de status (`.in("id", ids)` sem `.eq('status')`)
  - Evidência: `useCicloHoje.ts:146-155` · Origem: backlog 07-04 (aberto)
  - Ação: Guard de status no UPDATE + teste; considerar RPC atômica.
- ✅ #2205 · **M-03** (35) — Editor de quantidade grava `num_skus` em vez dos itens do pedido
  - Evidência: `PedidoRow.tsx:64-69` · Origem: backlog 07-04 (aberto)
  - Ação: Gravar itens; teste do caminho.
- ✅ #2206 · **M-04** (35) — `margin.ts` fabrica margem negativa: `unit_price || 0` (assimétrico com o custo)
  - Evidência: `src/lib/.../margin.ts:214-215`; `omie-vendas-sync:1296,1355` grava 0 · Origem: domínio A3
  - Ação: `continue`/`null` em item sem preço + `null` na edge + falsificação (ritual `/codex`).
- **M-05** (32) — `CockpitDrillDown` soma "Total" no cliente sobre `.limit(500)` e descarta `error` (zero fabricado)
  - Evidência: `CockpitDrillDown.tsx:49-52,100-107` · Origem: frontend FE-02 · P2 desde 07-04
  - Ação: Agregação server-side (RPC) + ler `error` e mostrar "indisponível".
- **M-07** (30) — "Faturado hoje" não filtra empresa (`companies` está na queryKey, não na query)
  - Evidência: `useVendasZone.ts:47-52` · Origem: backlog 07-04 (aberto)
  - Ação: Filtro na query + teste com 2 empresas.
- **M-08** (30) — `fin-funding` ainda filtra `status_titulo='ABERTO'` (valor morto; cashflow já corrigido)
  - Evidência: `fin-funding/index.ts:555` · Origem: backlog 07-04 (parcial)
  - Ação: Alinhar ao filtro do `fin-cashflow-engine:399` + sonda bump.
- **M-09** (30) — Policies `INSERT WITH CHECK (true)` para `authenticated` em `reposicao_motor_run` e `reposicao_estoque_nao_confirmado_log`
  - Evidência: policies `*_ins` no snapshot; leitor `AdminReposicaoPedidos.tsx:268-278` · Origem: segurança A1 · banco B09
  - Ação: `WITH CHECK (private.cap_compras_escrever(auth.uid()))` ou remover (service_role bypassa); prova `SET ROLE authenticated` exigindo 42501.
- **M-10** (30) — `signOut` sem `queryClient.clear()` — cache de outro usuário sobrevive à troca de sessão
  - Evidência: `AuthContext.tsx:368-373`; 0 ocorrências em `src/` · Origem: backlog 07-04 (aberto)
  - Ação: `queryClient.clear()` no signOut + teste.
- **M-06** (28) — Telas roteadas sobre objetos que NÃO existem em prod: `fila_aplicacao_omie` + RPC `gerar_fila_aplicacao_omie` e `quality_checklists`
  - Evidência: `useAplicacaoFila.ts:127`, `QualityChecklist.tsx`; `App.tsx:304,374`; 0 migrations · Origem: domínio A2 · banco B03 · confirmado via psql-ro
  - Ação: Decidir: criar migration OU remover rota+código. Gate `objeto-existe` lendo o snapshot (roda no CI sem banco).
- **M-11** (25) — "Gap de Margem" soma `.limit(100)` de um log append-only
  - Evidência: `IntelligenceStrategicTab.tsx:34,93` · Origem: backlog 07-04 (aberto)
  - Ação: Agregar no banco (view/RPC) ou paginar até vazio.
- **M-12** (25) — `SalesProducts` lê `omie_products` com `.select('*')` sem `.range` (capa silenciosa de 1.000)
  - Evidência: `SalesProducts.tsx:54-66` (mesma tabela paginada em `useFarmerScoring.ts:360`) · Origem: frontend FE-03
  - Ação: Usar o helper de paginação canônico + colunas enumeradas.
- **M-17** (25) — Retenção de `health_score_history` + `priority_score_log` (446 MB, +800k linhas/30d, sem expurgo)
  - Evidência: 1,05M + 1,04M linhas; 398k inserts/30d cada · Origem: medição própria
  - Ação: Job mensal de expurgo (>90d) + índice por data; ou agregar por semana.
- **M-13** (20) — `sales_price_history` com 5 linhas datadas de 2120-10-25
  - Evidência: `select count(*) ... where created_at > now()` = 5 · Origem: medição própria (psql-ro)
  - Ação: Corrigir as linhas + CHECK `created_at <= now() + interval '1 day'`; achar o writer.
- **M-14** (20) — Lote de higiene de 1 dia: apagar `bun.lockb` + `package-lock.json`; `.env` fora do git (allowlist); `concurrency` no `ci.yml`; `tsc -p tsconfig.node.json` no typecheck; shellcheck no CI (destravar #2093 com `--exclude=SC2317`)
  - Evidência: 3 lockfiles; `ci.yml` sem `concurrency`; `grep shellcheck ci.yml` = 0 · Origem: tooling T05/T06/T08/T14 · segurança A7/A13
  - Ação: 1 PR por item (auto-merge).
- **M-15** (20) — `timingSafeEq` centralizado em `_shared/auth.ts` + `REVOKE EXECUTE` de `wa_owner_efetivo` (grant a `authenticated` confirmado em prod)
  - Evidência: `_shared/auth.ts:33,52,62`; `proacl` = `authenticated=X` · Origem: segurança A9/A10 · confirmado via psql-ro
  - Ação: Revoke nomeando roles (padrão `revoke-que-nao-revoga.md`) + comparação constant-time.
- **M-16** (20) — Crons de features sem dado: `call-log-missed-backstop` roda a cada minuto (10.080×/semana) para `call_log` com 20 linhas; watchdogs `atp-*`, `pedidos-programados-watchdog`, `tint-watchdog-corante-5min`
  - Evidência: 93 jobs, 29.918 runs/7d · Origem: medição própria (cron.job_run_details 7d)
  - Ação: Desligar ou espaçar (`*/30`) os de módulo dormente; registrar decisão por job.
- **M-19** (20) — Docs: mover `analytics.md` §6 (600 linhas de diário), `ONDA1_*`, `handoff-cost-proxy-fix.md`, `docs/handoff/*` para `docs/historico/`; trocar contagens mortas por comandos ("119 rotas"→180, "30 worktrees"→79, "32/93 edges"→95)
  - Evidência: `mapa-do-app.md:3,78`; `money-path.md:26,187`; `deploy.md:98`; `worktrees.md:236,318` · Origem: docs D4/D9/D1-D3
  - Ação: 1 PR de mudança + 1 linha no índice cada.
- **M-21** (20) — Testes: preload que lança "use `bun run test`"; step `build-id-paridade` após o build (hoje é o `1 skipped`); remover tetos `15000`/`waitFor 10_000` do `priceGuard`
  - Evidência: `bunfig.toml:1-2`; `ci.yml:153` < `:285`; `SalesQuotes.priceGuard.test.tsx:74,84,93` · Origem: testes A9/A10/A11
  - Ação: 3 PRs pequenos.
- **M-18** (15) — Dropar `_quarantine_omie_clientes_20260722` (quarentena de 7 dias concluída em 27/07)
  - Evidência: 6.909 linhas; RLS ligada em prod (o "sem RLS" era artefato do snapshot) · Origem: banco B10 · memória 27/07
  - Ação: Migration `DROP TABLE` reversível (backup em `docs/historico`).
- **M-20** (15) — `CLAUDE.md`/`deploy.md` descrevem o gateway Lovable/Gemini como legado em uso — 0 edges usam (15 Anthropic direto)
  - Evidência: `CLAUDE.md:100`; `deploy.md:67-75` · Origem: edges E10
  - Ação: Atualizar as 2 frases; registrar em `docs/historico`.

### Fase 1 — Sensores e provas (19 itens · score somado 441)

- **M-28** (32) — Gate `casts-stale`: 79 dos 89 `.from/.rpc('x' as never)` apontam para nomes que `types.ts` JÁ tipa — o cast desliga a checagem de coluna (foi assim que #6 passou no typecheck)
  - Evidência: `useEndividamento:3`, `useTarefas:13`, `useEmbalagemConsulta:49,62`; 229 `as never` + 310 `as unknown as` · Origem: domínio A1/A15
  - Ação: Gate com denominador medido (baseline 10) + codemod por módulo; apagar tipos manuais já resolvidos (`types/prime.ts`, `types-departments.ts`).
- **M-39** (30) — Verificar o cano `$exception` do PostHog: 0 exceções em 30 dias com telas quebradas em prod é suspeito
  - Evidência: `ErrorBoundary.tsx:27` → `captureException`; query retornou 0 linhas · Origem: medição própria (HogQL)
  - Ação: Provocar 1 exceção controlada e confirmar chegada; senão, corrigir a captura.
- **M-25** (28) — Gate AST `erro-colapsado-em-vazio` custa 37s contra teto de 20s — pré-filtro textual antes do parse, sem subir teto
  - Evidência: `erro-colapsado-em-vazio-gate.test.ts:107`; `lib/gates/erro-colapsado-em-vazio.ts:61` · Origem: testes A1 · única falha da rodada
  - Ação: Filtrar por `return null`/`? null` + hook de leitura antes do `createSourceFile`; falsificar sabotando 1 arquivo da baseline.
- **M-27** (28) — Snapshot de schema: regerar com `db/refresh-snapshot.sh` (3 provas) + gate `wc -l` × manifest — o snapshot de 05/09 veio pelo bot do Lovable sem provas e o manifest está em 28/08
  - Evidência: `git log 1851416fc` = gpt-engineer-app[bot]; manifest 50.880 vs 51.692 linhas · Origem: banco B01
  - Ação: Rodar + gate no CI; regra: snapshot só entra por PR com manifest.
- **M-33** (28) — `omie-deadline.ts` nos 3 enumeradores Omie sem teto de relógio (`omie-vendas-sync`, `omie-analytics-sync`, `omie-sync`) + `_shared/anthropic-cliente.ts` com `timeout`/`maxRetries` nas 15 edges LLM
  - Evidência: `omie-vendas-sync/index.ts:231-237` (retry ×3 sem `signal`); 15× `new Anthropic({apiKey})` sem timeout · Origem: edges E01/E02
  - Ação: 2 PRs mecânicos; sonda bump.
- **M-22** (24) — CI na main após merge — hoje só o bot do Lovable dispara `push`; 56 dispatches manuais/30d pelo `/fecho`
  - Evidência: `ci.yml:56-80`; `auto-merge.yml` com `GITHUB_TOKEN`; `strict=false` · Origem: tooling T01
  - Ação: App token/PAT no auto-merge (ou merge queue, repo público = minutos grátis); aposentar o dispatch do `/fecho`.
- **M-24** (24) — vitest `environmentMatchGlobs`: `.test.ts` → node, `.test.tsx` → jsdom (+31 overrides `@vitest-environment jsdom`)
  - Evidência: `environment 2.184s` vs `tests 456s`; 429–447 arquivos puros · Origem: testes A2 · tooling T02
  - Ação: Config + medir ganho local (13,7 min) e no CI (Tests 221s).
- **M-26** (24) — Sonda de versão (`versao.ts`) nas 26 edges sem sonda — 9 com cron e 17 chamadas pelo browser, inclusive escritas irreversíveis (`omie-aplicar-parametros`, `whatsapp-send*`, `omie-sync`, `enviar-push`)
  - Evidência: matriz 95 edges: sonda 40/95 · Origem: edges E04 · issues #2129/#2147/#2140
  - Ação: Mecânico: 1 PR por lote de 8; passa a ter prova passiva no `/fecho`.
- **M-30** (24) — `ErrorBoundary` único acima de `<Routes>` — tela quebrada derruba o shell inteiro
  - Evidência: `App.tsx:227-446`, `ErrorBoundary.tsx:34` · Origem: frontend FE-01
  - Ação: `<ErrorBoundary key={location.pathname}>` ao redor do `<Outlet/>` no `AppShellLayout`.
- **M-31** (24) — Sentinela `authz:rls:prod` não cobre `webauthn_credentials` (2º fator), `tint_formula_itens` (receita), `whatsapp_*`/`farmer_calls` (PII), `company_config`
  - Evidência: `scripts/authz-rls-esperado.ts` (33 tabelas, 0 menções) · Origem: segurança A3
  - Ação: Estender a lista esperada + carimbo.
- **M-36** (24) — LGPD: transcrições (ligação/WhatsApp/copilot) sem retenção/expurgo + payload com PII de cliente em logs de edge
  - Evidência: `farmer_calls.transcript`, `whatsapp_messages.transcript`; `omie-vendas-sync:2102`, `omie-nfe-webhook:93` · Origem: segurança A2/A8
  - Ação: Prazo de retenção (decisão do founder) + cron de expurgo + redigir PII nos logs.
- **M-32** (21) — Carimbo de migrations aplicadas (mesmo padrão do `authz:carimbo`) — `audit-custom-migrations.sql` (4.460 linhas) foi regenerado 268× sem nenhum resultado de prod commitado
  - Evidência: 268 commits; `schema_migrations` fail-open · Origem: banco B02 · issues #2139/#2141
  - Ação: `audit:migrations:prod` grava carimbo; gate compara migrations do repo × carimbo.
- **M-23** (20) — `bun run gates:rapidos` (~5s) disparado pelo `pr-collision-guard` antes do `gh pr create` — 36% das falhas de CI em 60d são gates de 0–2s
  - Evidência: knip 24 · authz 10 · fingerprint 7 falhas; 4/5 falhas de Tests = `docs-indice` · Origem: tooling T03
  - Ação: Script agregador + hook; falsificar sabotando 1 gate.
- **M-29** (20) — `deno.lock` para o `edges:typecheck` — único gate com rede resolve o registry ao vivo (2 mains vermelhas sem culpado em 3 semanas)
  - Evidência: run 33761853248 (`@rolldown/binding…`); 86 edges em `npm:…@2` · Origem: tooling T04
  - Ação: Commitar lock + `--frozen`; bump por PR.
- **M-34** (20) — Lint ratchet `--max-warnings 74` + `no-floating-promises` (`checkThenables`) só em services/hooks/queries
  - Evidência: 74 warnings (todos `exhaustive-deps`); classe "thenable preguiçoso" em `database.md:142` · Origem: tooling T07
  - Ação: Ratchet primeiro; regra nova com baseline.
- **M-37** (20) — `cron.job` capturado no snapshot/DR — runbook diz 33 crons, prod tem 93
  - Evidência: `refresh-snapshot.sh` sem `cron.job` · Origem: banco B08 · medição própria
  - Ação: Dump de `cron.job` no refresh + diff no CI.
- **M-40** (18) — Job `db-harness` no CI: `services: postgres:17`, allowlist de 8–12 harnesses money-path em PR que toca `db/`/migrations + nightly — 270 harnesses (84k LOC) hoje só rodam à mão
  - Evidência: `rg 'db/test-' ci.yml package.json` = 0; `harness-template.sh:18` fixa `/opt/homebrew` · Origem: testes A3
  - Ação: `PGBIN` por env; começar pelos harnesses de reposição/financeiro.
- **M-35** (16) — Gates de convenção com baseline (padrão do repo) para o que o CLAUDE.md afirma sem sensor: cores cruas (94 em 32 arquivos), `useUrlState` (6/172 páginas), `PageHeader` (0/126 `<h1>`), chaves RQ (622 literais, 0 fábrica → `@tanstack/eslint-plugin-query`), `div onClick` sem teclado (11)
  - Evidência: `Admin.tsx:142-149`; `RecebimentoConferencia.tsx:552` · Origem: frontend FE-06..09/12
  - Ação: 1 gate por convenção, baseline por contagem, sentinela de varredura vazia.
- **M-38** (16) — `registro-execucao` nas 13 ações bilaterais (cron + clique) que hoje não registram em lado nenhum
  - Evidência: `registro-execucao` em 3/33 edges com cron; `useUltimaExecucao.ts:33` · Origem: edges E08
  - Ação: Adotar o helper server-side; painel `<UltimaExecucao>` passa a ter dado.

### Fase 2 — Triagem de superfície (7 itens · score somado 133)

- **M-41** (21) — 🧭 Triagem de superfície, módulo a módulo — ativar com sensor · congelar (esconder rota, manter código) · arquivar (remover código + tabelas + crons + edges): loja-afiacao (10,8k LOC, `orders` 0 linhas), telefonia/whatsapp/rota (14,2k), tarefas (3,8k), prime (2,4k), produção (1k), picking (~3k), knowledge-base (5,3k), governança (10,7k), admin-crm (6,7k), telas de INPUT do financeiro (25 tabelas `fin_*` jamais escritas)
  - Evidência: 15 rotas com pageview em 90d de ~180; 162 tabelas jamais escritas; 5 usuários · Origem: medição própria (PostHog + banco + manifesto)
  - Ação: Reunião de 1h com a tabela "superfície × uso"; registrar decisão por módulo no manifesto (`status: ativo|congelado|arquivado`).
- **M-43** (21) — `tint_*` = 2,8 GB (67% do banco) com reescrita contínua: 1,86M inserts/30d, 213M deletes acumulados, `tint_sync_errors` 20k/30d — delta-sync por hash em vez de rewrite; limpar staging; expurgo de `tint_sync_runs/errors`
  - Evidência: `tint_formula_itens` 1.099 MB, 234k dead tuples · Origem: medição própria
  - Ação: Medir custo (Supabase compute/IO) → redesenhar o sync (`tint-sync-agent`) com upsert por hash.
- **M-42** (20) — Dropar as tabelas jamais escritas (162) que a triagem liberar — migration reversível após `git grep` + `pg_stat`
  - Evidência: `tabelas-jamais-escritas.txt`; 72 tabelas em prod sem CREATE no repo · Origem: medição própria · banco B12
  - Ação: Lotes por módulo; backup lógico antes.
- **M-45** (20) — README humano (~80 linhas): bun, `.env.example`, PR → auto-merge → 3 deploys manuais, worktrees, `psql-ro` — hoje é boilerplate Lovable com `REPLACE_WITH_PROJECT_ID` ×3 e `npm i`
  - Evidência: `README.md` 73 linhas intocado · Origem: docs R1/D10
  - Ação: Escrever; linkar do CLAUDE.md.
- **M-46** (20) — Worktrees: 79 vivas, 22 `node_modules` = 16,7 GB, 70 anteriores a setembro
  - Evidência: `git worktree list`, `du` · Origem: tooling T09
  - Ação: `wt:reap`/`wt:prune` com allowlist das sessões vivas.
- **M-44** (16) — `docs/superpowers/` congelado (372/446 órfãos, 1 plan/mês) + `INDEX.md` + arquivo por trimestre; skill `lovable-deploy-verify` (984 linhas / 86 KB por invocação) fatiada
  - Evidência: 17% dos arquivos referenciados; fora de todo gate · Origem: docs S1/K1
  - Ação: Política escrita + índice gerado.
- **M-47** (15) — Edges órfãs (`verify-employee`, `gmail-webhook-receiver`) e `omie-sync` (1.676 LOC, 29 `case`, sem sonda/teste/timeout/lease) — provar lado prod e aposentar/decompor
  - Evidência: únicas refs: `TechnicalDocs.tsx:260` / nenhuma · Origem: edges E12/E11
  - Ação: Confirmar invocações em prod (logs) → remover ou documentar.

### Fase 3 — Canônicos (9 itens · score somado 156)

- **M-49** (24) — `src/lib/money/`: `formatarBRL` canônico (39 formatadores, `null`→"—" em vez de "R$ 0,00"), `arredondar` com EPSILON (16 `roundN` locais), `hojeSP` (26 sites `toISOString().slice(0,10)` + 5 implementações de "hoje")
  - Evidência: `lib/grupos/format.ts:13`; `EventosManager:200,214`; `Math.round(1.005*100)/100 === 1` · Origem: domínio A4/A5/A9 · backlog "datas UTC"
  - Ação: 3 helpers + gate que barra novos locais; migrar por módulo.
- **M-53** (20) — Auth de edges via `_shared/auth.ts` (14 gates `x-cron-secret` reimplementados à mão, 6 money-path) + `config.toml` fiel ao gateway real
  - Evidência: 46 edges sem entrada chamadas por cron sem JWT · Origem: edges E07
  - Ação: Trocar gate a gate com teste; gate textual barra reimplementação.
- **M-56** (20) — Ratchet de fronteiras de módulo que APERTA: baseline estagnada em 230 arestas (+10/−6 em 2 meses; farmer↔telefonia 40) e o gate aceita aresta nova por comando
  - Evidência: `fronteiras-baseline.ts` · Origem: domínio A7
  - Ação: Baseline só encolhe; adição exige registro no PR.
- **M-51** (18) — Parsers zod nas fronteiras `.rpc()`/`functions.invoke()` money-path (169 casts `data as X`, 0 zod) — começar por `useAplicacaoFila`, `AdminReposicaoPedidos` (disparo a fornecedor), `financeiroV2Service`
  - Evidência: `useAplicacaoFila:131`, `AdminReposicaoPedidos:502`, `financeiroV2Service:674-679` · Origem: domínio A8
  - Ação: Schema por RPC crítica; erro de parse degrada para `null`/baixa confiança.
- **M-50** (16) — Paginação PostgREST: 1 helper canônico (11 hoje, 6 fora do pin G2) + assinatura de `fetchAllPages` que elimina os 24 `as unknown as PromiseLike`
  - Evidência: `buscarTodasPaginas` privado no V1 vs `fetchAllPages` no V2 · Origem: domínio A10/A11
  - Ação: Unificar + pin cobrindo todos.
- **M-54** (16) — Índices: 116/204 FKs sem índice (priorizar `tint_staging_*.sync_run_id`, `tint_formula_itens.corante_id`, `picking_events`) e 18 redundantes (7 duplicatas exatas)
  - Evidência: `inventory_position` 2 UNIQUE iguais; `idx_fin_cp_company` ⊂ 4 compostos · Origem: banco B05/B06
  - Ação: Medir `idx_scan` via psql-ro antes; migration por lote.
- **M-52** (15) — Harness PG17: lib compartilhada de bootstrap (267 cópias de `initdb`/stub `auth.uid`; `safeupdate` em 1/270)
  - Evidência: lição #1616 não propaga · Origem: banco B07
  - Ação: `db/lib/harness.sh` + migração gradual; template novo obrigatório.
- **M-55** (15) — Camada de dados única: `queries/` ≡ `hooks/`; 73 arquivos de UI com supabase direto; `services` 0/45 com react-query — regra escrita + migração incremental
  - Evidência: 0 docs de critério · Origem: domínio A6
  - Ação: Decidir critério (dado → `queries/`, orquestração → `hooks/`, I/O puro → `services/`) + gate para arquivo NOVO.
- **M-48** (12) — Cliente Omie compartilhado: 25 wrappers `omieCall`, 22 leitores de credencial, 16 retries, 12 `sleep`, 9 conversores de data → `_shared/omie-cliente.ts` (timeout, retry, paginação até página vazia)
  - Evidência: `rg "async function omieCall"` = 25 · Origem: edges E06 · #1614/#1623 foram correções wrapper a wrapper
  - Ação: Cliente + migração edge a edge com sonda bump; gate proíbe `omieCall` novo fora do `_shared`.

### Fase 4 — Motores, monólitos e dependências (4 itens · score somado 75)

- **M-60** (24) — `prime`: writer sem teste (`usePrimeAdmin.ts` 344 LOC, 14 rpc/insert; 33 asserts só na fórmula) — apenas se sair da triagem como "ativar"
  - Evidência: `src/lib/prime/prime.test.ts` único · Origem: testes A6
  - Ação: Condicionado ao item 41.
- **M-58** (21) — Edges monólitos: extrair ~2,5k LOC puras + testes Deno — começar por `disparar-pedidos-aprovados` (1.923 LOC, cria pedido na Omie, só contrato de sonda), `fin-valor-engine`, `fin-cashflow-engine` (26 fn/708 LOC), `omie-financeiro` (31 fn/767 LOC)
  - Evidência: 76/95 edges sem teste; 0 testes importam `index.ts` · Origem: edges E05 · testes A4
  - Ação: Módulo `logica.ts` importável + teste; `index.ts` vira casca.
- **M-59** (18) — Dependências: 22 majors atrasados — ordem segura: minors radix/hookform → `date-fns` 4, `jsdom` 26, `react-day-picker` 9, `lucide` → `zod` 4 → `react-router` 7 → `tailwind` 4; Vite 8 BLOQUEADO pelos peers de `lovable-tagger`/`vite-plugin-pwa`
  - Evidência: `bun-outdated.txt`; overrides cross-major · Origem: tooling T13
  - Ação: 1 major por PR com build+suíte; nunca em lote.
- **M-57** (12) — Extrair os 4 motores de decisão para `src/lib/*/motor.ts` puro + testes: `useRoutePlanner` (1.456 LOC, 30 `useState`, 0 testes), `useBundleEngine` (`calculateBundles` 1.096 LOC num `useCallback`), `useCrossSellEngine` (1.227), `useTacticalPlan` (989)
  - Evidência: 5.100 LOC em hooks com fetch manual; testados só por `renderHook` · Origem: frontend FE-04/05 · testes A5
  - Ação: 1 motor por PR: função pura + fixtures + hook fino.

## 6. Decisões que só o founder pode tomar 🧭

1. **Triagem de superfície (M-41)** — por módulo sem sinal: *ativar com sensor* (instala o sensor antes de qualquer feature nova, regra de `fase-sem-sinal.md`), *congelar* (esconde rota, mantém código, para de receber correções) ou *arquivar* (remove código + tabelas + crons + edges, com backup). A tabela de §2.2 é o insumo; a decisão vai para o manifesto (`status` por módulo) e é o que destrava M-42, M-16, M-47 e o SW do picking.
2. **Objetos fantasma (M-06)** — criar a migration de `fila_aplicacao_omie`/`gerar_fila_aplicacao_omie`/`quality_checklists` ou remover as duas telas. Hoje quem abre `/admin/reposicao/sessao/aplicacao` ou `/admin/orders/:id/quality` recebe erro.
3. **CI na main após merge (M-22)** — App token/PAT no `auto-merge.yml` (custo: gerir credencial) × merge queue (muda o fluxo do repo; repo público = minutos grátis).
4. **Harness PG17 no CI (M-40)** — quais 8–12 harnesses money-path entram no PR e quais ficam no nightly.
5. **Retenção LGPD (M-36)** — prazo para transcrições/gravações de ligação, WhatsApp e copilot.
6. **Upgrades grandes (M-59)** — quando fazer `react-router` 7 e `tailwind` 4; Vite 8 fica bloqueado até `lovable-tagger`/`vite-plugin-pwa` acompanharem.
7. **`tint_*` (M-43)** — o custo atual (67% do banco, reescrita diária) é aceitável ou vale redesenhar o sync?
8. **Pendências da auditoria de UX** (`docs/ux-audit/04-execucao.md`): schema de `nfe_receipt_runs`/`user_segments` (hoje localStorage), redirect mobile do picking, `/unified-order`.

## 7. O que NÃO fazer (anti-plano)

- **Não subir o teto do gate AST** (M-25): o custo é o bug; subir o teto esconde. O mesmo vale para `priceGuard` (M-21).
- **Não instalar lint de shell nas cercas de skill** — medido e recusado em 2026-08-31 (`docs/agent/skills.md`).
- **Não reimplementar o `03-roadmap.md` da auditoria de UX** (20/20 entregue): é proveniência, não backlog.
- **Não fazer majors em lote nem Vite 8 agora** (peers bloqueiam); 1 major por PR com build + suíte.
- **Não ligar `security_invoker=on` cego**: as `selfservice_*` com `off` são desenho; e todo `CREATE OR REPLACE` de view repete o `WITH (security_invoker=…)`.
- **Não dropar tabela sem `git grep` + `pg_stat` + backup; nunca tocar `supabase/migrations/`.**
- **Não migrar os 39 formatadores (ou os 25 wrappers Omie) num PR só**: classe por classe, e o PR que cria o canônico nasce com o gate que barra o novo local.
- **Não adicionar `jsx-a11y`/lint type-aware sem baseline** — vira ruído e fricção no repo multi-sessão. Ratchet primeiro (M-34).
- **Não tratar verde como prova**: gate novo nasce com sentinela de varredura vazia e falsificação (regra do repo); prova de deploy é a sonda, não o merge.
- **Não confiar em `total_de_paginas`, `?? 0` em money-path, nem em `.or()` cru** — armadilhas já catalogadas no CLAUDE.md; o plano só as reforça com sensores.

## 8. Como medir (KPIs do plano)

| KPI | Hoje | Alvo em 90 dias |
|---|---|---|
| P1 herdados da revisão de 07-04 ainda abertos | 16 (+4 parciais) | 0 |
| Telas roteadas sobre objeto inexistente em prod | 2 | 0, com gate `objeto-existe` |
| Edges sem sonda de versão | 26/95 (9 com cron) | 0 |
| Issues "deploy pendente" abertas | 8 | 0, sem reabrir por 30 dias |
| `.from/.rpc('x' as never)` com motivo expirado | 79/89 | 0 (gate `casts-stale`) |
| Dispatches manuais de CI por mês | 56 | 0 |
| Falhas de CI causadas por gates de 0–2s | 36% das falhas | <5% |
| CI (parede) · suíte local (`heavy`) | ≈7,5 min · 13,7 min | <5 min · <8 min |
| Tabelas `public` jamais escritas | 162 | <40 (após triagem) |
| Banco | 4,2 GB (tint 2,8) | <2,5 GB |
| Crons ativos | 92 (1 por minuto p/ módulo morto) | ≤60, nenhum por minuto sem dado |
| Módulos com decisão registrada (ativo/congelado/arquivado) | 0/17 | 17/17 |
| Convenções do CLAUDE.md com sensor no CI | 3/8 | 8/8 |
| Harnesses PG17 money-path no CI | 0/270 | 8–12 em PR + nightly |
| Transcrições com prazo de retenção | 0 | 100% |

## 9. Anexos

| Arquivo | Conteúdo |
|---|---|
| [`anexos/00-medicoes-proprias.md`](anexos/00-medicoes-proprias.md) | health stack, PostHog, banco, crons, superfície × uso |
| [`anexos/relatorio-frontend.md`](anexos/relatorio-frontend.md) | pages/components/hooks/contexts — 14 achados + medições + descartes |
| [`anexos/relatorio-dominio.md`](anexos/relatorio-dominio.md) | lib/services/queries/types — 15 achados |
| [`anexos/relatorio-edges.md`](anexos/relatorio-edges.md) | 95 edges — 13 achados + matriz edge × gate × sonda × registro × teste |
| [`anexos/relatorio-banco.md`](anexos/relatorio-banco.md) | snapshot/migrations/db — 13 achados |
| [`anexos/relatorio-tooling.md`](anexos/relatorio-tooling.md) | CI/scripts/hooks/deps — 15 achados + tempos por step |
| [`anexos/relatorio-testes.md`](anexos/relatorio-testes.md) | suíte vitest/Deno/PG17 — 14 achados + cobertura por módulo de risco |
| [`anexos/relatorio-docs.md`](anexos/relatorio-docs.md) | backlog herdado (38 itens verificados) + saúde da documentação |
| [`anexos/relatorio-seguranca.md`](anexos/relatorio-seguranca.md) | authz/RLS/edges/LGPD/supply-chain — 13 achados, 0 P0/P1 |
| [`anexos/loc-por-modulo.tsv`](anexos/loc-por-modulo.tsv) · [`anexos/tabelas-jamais-escritas.txt`](anexos/tabelas-jamais-escritas.txt) · [`anexos/atividade-tabelas-30-90d.tsv`](anexos/atividade-tabelas-30-90d.tsv) | dados brutos das medições |

> Manutenção deste documento: ao fechar um item, marque `✅ #PR` na linha correspondente da tabela de §4 e registre em `docs/historico/`. O plano é uma foto de 2026-09-05; os KPIs de §8 são os que devem ser re-medidos, não o texto.
