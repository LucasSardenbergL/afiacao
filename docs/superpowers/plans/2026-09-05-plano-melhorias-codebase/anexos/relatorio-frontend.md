# Auditoria frontend — `src/pages` · `src/components` (exceto `ui/`) · `src/hooks` · `src/contexts` · `App.tsx` · `AppShell.tsx`

Data: 2026-09-05 · Worktree `intelligent-yalow-39d4e7` (branch `claude/code-improvements-plan-2bc5f9`) · Read-only.
Escopo medido: 172 páginas · 525 componentes (fora `ui/`) · 178 hooks · 10 contexts · 180 `<Route>` (162 lazy).
Health em background: typecheck 0 · lint 0 · knip 0 · **test exit=1** (1/751 — `erro-colapsado-em-vazio-gate` estourou timeout de 20s sob RAM; é flake de infra, não regressão — escopo do subagente de testes).

Formato: `ID | título | categoria | evidência | por que importa | proposta | I·R·E`

---

## Achados

**FE-01 | Um único `ErrorBoundary` acima de `<Routes>`: qualquer tela que quebra derruba o shell inteiro e só volta com reload | arquitetura/UX**
Evidência: `src/App.tsx:227-228,446` (`<ErrorBoundary><Suspense><Routes>…`), `src/components/ErrorBoundary.tsx:34` (`window.location.reload()` é a única saída; 70 linhas, sem `resetKeys`/reset por rota), `src/components/AppShell.tsx` não envolve `children`/`Outlet` em boundary (`AppShellLayout` em `App.tsx:237`).
Por que importa: um erro de render numa tela analítica apaga sidebar, topbar e o discador; o operador no picking perde a navegação. `errorElement` do react-router não está disponível (é `BrowserRouter` + `<Routes>`, não data router).
Proposta: em `AppShellLayout`, `<ErrorBoundary key={location.pathname} fallback={<TelaQuebrou onVoltar/>}>` ao redor do `<Outlet/>` — o boundary global fica como último recurso; adicionar `resetKeys`/`componentDidUpdate` no `ErrorBoundary.tsx`.
I=4 · R=2 · E=2

**FE-02 | Money-path: `CockpitDrillDown` soma "Total" no cliente sobre `.limit(500)` e descarta `error` — fabrica zero e subestima | segurança (money-path)**
Evidência: `src/components/financeiro/CockpitDrillDown.tsx:49-52` (`loadData(type).then(...)` sem `.catch`; `const { data } = await …` — `error` nunca é lido, 0 hits no arquivo), `:100-107` (`fin_contas_receber .select('*') … .limit(500)` + `rows.reduce`), `:65` (`{data.length} registros · Total: {fmt(total)}`); 4× `.limit(500)` (CR/CP/saldo). **Já apontado como P2 em `docs/historico/revisao-completa-2026-07-04.md:43` — segue aberto 2 meses depois.**
Por que importa: >500 títulos abertos → total menor sem aviso; falha de leitura → "R$ 0,00" (CLAUDE.md: ausente ≠ zero). É a tela de cockpit do Financeiro.
Proposta: total por agregação server-side (RPC `sum` ou `head:true, count:'exact'` + rótulo "500 de N — parcial"); ler `error` e degradar para `null`/"indisponível"; `select` enumerado (o próprio ESLint já barra `select('*')` em `sales_orders` — estender a mensagem a `fin_*`). Money-path → ritual `/codex` + `prove-sql-money-path` se virar RPC.
I=5 · R=3 · E=2

**FE-03 | `SalesProducts`: `omie_products .select('*')` sem `.range`/`.limit` → capa silenciosa de 1.000 do PostgREST | código/perf**
Evidência: `src/pages/SalesProducts.tsx:54-66` (`loadProducts` manual: `.from('omie_products').select('*').eq('account')…order()` sem paginação, `setProducts(data)`), contraste `src/hooks/useFarmerScoring.ts:360-363` — pagina a MESMA tabela com `.range(de, ate)` (prova de que passa de 1.000). Lista renderizada com `.map(` sem virtualização.
Por que importa: CLAUDE.md §Armadilhas — a capa de 1.000 é silenciosa; o vendedor vê catálogo truncado por ordem de `ativo, descricao` e não sabe. Incerteza: depende do volume por `account` (não consultei o banco).
Proposta: `useInfiniteQuery` + `.range()` + `.order('id')` estável + `select` enumerado; `useInfiniteScroll` (convenção do CLAUDE.md).
I=4 · R=2 · E=2

**FE-04 | `useRoutePlanner.ts` (1.456 linhas): 30 `useState`, 13 `useEffect`, 15 loaders `async` com 18 `.from(` — camada de dados 100% manual, 0 `useQuery`, 0 teste co-localizado | arquitetura**
Evidência: `src/hooks/useRoutePlanner.ts:204-246` (7 `useEffect` disparando `loadLogisticStops/loadCommercialStops/loadScheduledVisits/loadTodayVisits/loadManualCustomers`), `:262-613` (loaders; 9 `console.error`, 7 `toast.error`); único consumidor `src/pages/AdminRoutePlanner.tsx` (503 linhas, 0 `useQuery`). A lógica pura JÁ saiu para `src/lib/route/*` (13 módulos, todos com `.test.ts`) — o que ficou é I/O + estado.
Por que importa: cache, dedupe, retry, loading e erro reimplementados à mão em 5 fontes; nada invalida nada (check-in não refaz visitas de hoje sem recarregar); erro vira `console`.
Proposta: quebrar em `useRotaParadasLogisticas`/`useRotaParadasComerciais`/`useRotaVisitasHoje`/`useRotaAgendadas` com `useQuery` (chave `['rota', contexto, userId]`) e mutações `handleCheckIn/Out` com `invalidateQueries` do prefixo; `useRoutePlanner` vira composição fina.
I=3 · R=3 · E=4

**FE-05 | Motores Farmer: `calculateBundles` = 1.096 linhas num único `useCallback`; `calculateRecommendations` = 1.015; `generatePlan` = 274 — a extração para `src/lib/{tactical,farmer}` começou, mas o miolo continua no hook | arquitetura**
Evidência: `src/hooks/useBundleEngine.ts:250-1346` (1 `useCallback`, 0 `useMemo`/`useEffect` — é lógica imperativa hospedada em hook), `src/hooks/useCrossSellEngine.ts:191-1206`, `src/hooks/useTacticalPlan.ts:561-835`; `src/lib/tactical/` só tem `bundle-numeros/plano-duplicata/pregeracao/telemetria` (4 módulos). Os hooks aparecem em 29/24/18 arquivos de teste, mas via página/gate — o motor é testado por render.
Por que importa: scoring/montagem de bundle é decisão comercial; testá-la exige montar React + mocks de Supabase; qualquer ajuste de peso é PR de 1.000 linhas de contexto.
Proposta: mover o miolo puro (associação, ranking, comparação individual, classificação de perfil) para `src/lib/farmer/bundles/montar.ts` e `src/lib/tactical/gerar-plano.ts` com entrada = dados já buscados; hook fica com fetch + `aplicar*`. Recorte seguro: começar por `generatePlan` (274 linhas, já tem `classifyProfile` puro em `useTacticalPlan.ts:247`).
I=3 · R=3 · E=4

**FE-06 | React Query sem fábrica de chaves: 622 `queryKey` literais, 0 via fábrica; 278 `invalidateQueries` (195 por prefixo de 1 segmento); sem `@tanstack/eslint-plugin-query` | arquitetura**
Evidência: medição (`rg "queryKey: \['"` = 622; `queryKey: (queryKeys|chaves|qk).` = 0; nenhum `export const queryKeys` em `src`); variações para o mesmo domínio: `['orders']`, `['order-detail']`, `['pedidos-ciclo']` (17 leitores), `['pedido-itens']`, `['embalagem-pedido']`; ESLint só tem `react-hooks` + `react-refresh` (`eslint.config.js:3,22`).
Por que importa: um typo numa chave = cache órfão ou invalidação que não pega, sem erro nem teste que veja; `exhaustive-deps` de `queryFn` ninguém confere.
Proposta: `src/lib/queryKeys.ts` por domínio (começar por reposição e financeiro, onde há 17+7 invalidações do mesmo prefixo) + `@tanstack/eslint-plugin-query` (`exhaustive-deps`, `no-rest-destructuring`). Migração incremental, sem big-bang.
I=3 · R=2 · E=3

**FE-07 | `useUrlState` adotado em 6/172 páginas em 4 meses (nasceu 2026-05-13, `300ff0893`); 32 páginas guardam filtro/busca em `useState`; o período do Financeiro (`ano`/`mes`) é `useState` copiado em 6 páginas | UX/código**
Evidência: `src/pages/AdminReposicaoAlertas.tsx:27-30` (4 filtros), `AdminReposicaoPromocoes.tsx:21-23`, `AdminReposicaoGruposProducao.tsx:26-28` (mesmo shape `{busca, filtroX}`); Financeiro: `FinanceiroTributario.tsx:52`, `FinanceiroFechamento.tsx:44`, `FinanceiroAnalytics.tsx:38-39`, `FinanceiroIntercompany.tsx:30-31`, `FinanceiroOrcamento.tsx:80`, `FinanceiroDashboard.tsx:51`, com `<Select value={String(ano)}` copiado em 5 e 0 hook/contexto de período compartilhado (`usePeriodOverride` é outra coisa).
Por que importa: link não carrega o filtro, F5 zera, "me manda o que você está vendo" não funciona; a convenção do CLAUDE.md §DS não tem sensor.
Proposta: (a) `usePeriodoFinanceiro()` sobre `useUrlState({ano, mes})` + `<SeletorPeriodo>` em `src/components/financeiro/` — 6 páginas viram 1 fonte; (b) migrar as 3 `AdminReposicao*` de filtro idêntico; (c) gate textual com baseline para `useState.*(filtro|busca|search)` em `src/pages`.
I=3 · R=1 · E=2 (a+b) / 3 (com gate)

**FE-08 | Não existe `<PageHeader>`: 126/126 páginas montam `<h1>` à mão com ≥6 assinaturas de classe | UX/código**
Evidência: `<h1 className="text-2xl font-bold"` ×27, `"text-xl font-semibold"` ×16, `"text-2xl font-bold tracking-tight"` ×10, `"font-display text-3xl"` ×9, `"text-lg font-semibold"` ×8, `"font-display text-2xl"` ×8 (130 `<h1>` em pages; 95 sem `font-display`); wrappers copiados: `container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl` ×5 nas `AdminReposicao*`, `<div className="p-6"` ×12 nas `Financeiro*`; 0 `PageHeader` no histórico do git.
Por que importa: a direção v3 desloca a identidade para tipografia/spacing (`01-direcao.md` §5) — hoje cada página decide o hero; migrar tipografia depois vira 126 PRs.
Proposta: `src/components/shell/PageHeader.tsx` (título `font-display`, descrição, `actions`, breadcrumb opcional) + `PageContainer`; migrar por módulo (Financeiro 21 → AdminReposicao 25 → Farmer 10). Registrar no manifesto.
I=3 · R=1 · E=3

**FE-09 | Cores cruas de status: 94 ocorrências em 32 arquivos (fora do adapter `StatusBadge`); 20 só em `Admin.tsx`; aderência a `text-status-*` é 96% (2.326 usos) mas sem gate | UX**
Evidência: `src/pages/Admin.tsx:142-149` (`border-orange-300 bg-orange-50 … text-orange-900`), `:213` (yellow), `src/pages/Gamification.tsx` (6), `src/components/KanbanBoard.tsx:41-43`, `src/components/rota/planner/constants.ts:29-31` (paleta categórica de tipo de parada), `src/hooks/useDiagnosticQuestions.ts` (4); nenhum gate em `scripts/`/`eslint.config.js`. `StatusBadge.tsx:12-16` é adapter legado→token (legítimo).
Por que importa: com primary neutro, os status são as únicas cores cromáticas da tela (`01-direcao.md` §5) — `orange-50/amber-500` saturados são exatamente a fadiga que a v3 eliminou; sem gate, regride a cada PR.
Proposta: gate textual com baseline (padrão do repo, `src/__tests__/*-gate.test.ts`, stripper compartilhado) para `(text|bg|border)-(emerald|red|green|amber|rose|orange|yellow|sky|blue)-\d{3}` em `src/pages`+`src/components` (exceto `ui/` e adapters); migrar `Admin.tsx` e `Gamification.tsx`; decidir token **categórico** (não existe `--chart-*` em `src/index.css`) para Kanban/rota antes de migrá-los.
I=2 · R=1 · E=2

**FE-10 | `AppShell.tsx` (912): 125 linhas de nav estática em TSX (L89-224) + 5 `useQuery` de badge inline em `AppSidebar` (L414-488) | arquitetura/perf**
Evidência: `src/components/AppShell.tsx:89` (`unifiedNavSections`), `:214` (`docNavSection`), `:414,431,450,471,488` (`outlierPendentes`, `pedidosPendentes`, `aumentosAtivos`, `negociacaoNovasCount`, `notificacoesPendentes`) + 6 hooks de badge; 43 imports; `React.memo` já aplicado nos 3 subcomponentes.
Por que importa: a sidebar renderiza em toda rota; cada badge novo cresce o arquivo mais quente do app; nav em dados serviria Cmd-K, ajuda e gate de rotas (o manifesto já tem `rotaPrefixos`).
Proposta: `src/components/shell/nav-config.ts` (dados puros) + `useSidebarBadges()` (agrega as 5 queries num hook, mesmas chaves) — recorte mecânico, sem mudança de comportamento.
I=2 · R=1 · E=2

**FE-11 | Páginas god-file com componentes já nomeados inline: `AdminEstoquePicking` (774: 7 componentes internos, 9 `useQuery`, 11 `.from(`), `TarefasTemplates` (858: `TemplateDialog` L240-680 = 440 linhas), `RecebimentoConferencia` (859: 18 `useState`, 2 dialogs L789/L820), `AdminReposicaoPedidos` (969: 9 `useQuery`, 5 mutations) — 0 teste de página nos 4 | arquitetura**
Evidência: `src/pages/AdminEstoquePicking.tsx:60,75,204,303,466,549` (`StatusBadge`, `KpiCards`, `PedidosASepararTab`, `PickingTab`, `EstoqueTab`, `MovimentacoesTab`), `src/pages/TarefasTemplates.tsx:240,682`; `src/components/picking/` (3 arquivos) e `src/components/tarefas/` (6) já existem; `src/pages/__tests__` tem 14 testes para 172 páginas. 30 páginas ≥400 linhas.
Por que importa: o picking é tela crítica offline-first; hoje cada aba carrega no bundle da página e não pode ser testada isolada.
Proposta: mover os componentes já nomeados para `src/components/picking/` e `src/components/tarefas/` (co-localizar teste), sem tocar em comportamento; `TintApiContract.tsx` (993) é documentação estática — ignorar.
I=2 · R=1 · E=2

**FE-12 | A11y sem sensor: nenhum `eslint-plugin-jsx-a11y`; 11 `div onClick` sem `role`/`tabIndex`, inclusive no chão de fábrica e no cockpit financeiro | UX**
Evidência: `src/pages/RecebimentoConferencia.tsx:552` (item da conferência clicável só por mouse), `src/components/financeiro/cockpit/MiniCard.tsx:8` (KPI com `onClick` opcional, sem teclado), `src/components/farmer/bundles/CustomerBundleCard.tsx:54`, `src/components/KanbanBoard.tsx` (4), `src/components/sales/print/OrderGroup.tsx` (4); `eslint.config.js` só carrega `react-hooks`/`react-refresh`; `<Input` 391 vs `<Label htmlFor` 187 (aproximação — tags multilinha).
Por que importa: o placar do `mapa-do-app.md` marca WCAG AA como ✅ com base em touch 44px — mas nada no CI mede foco/teclado/rótulo; o ✅ afirma sem sensor (mesma classe de `fase-sem-sinal.md`).
Proposta: `eslint-plugin-jsx-a11y` (`click-events-have-key-events`, `no-static-element-interactions`, `label-has-associated-control`) com baseline; converter os 11 em `<button>`/`role="button"`+`tabIndex={0}`+`onKeyDown`.
I=3 · R=1 · E=2

**FE-13 | `useMutation` cru em ação global (gerar/sincronizar) na Reposição e no Analytics — convenção `useMutationComRegistro` nasceu 2026-07-18 e estes ficaram para trás | código**
Evidência: `src/components/reposicao/aplicacao/useAplicacaoFila.ts:125-132` (`gerarFila` → RPC `gerar_fila_aplicacao_omie`), `:146-152` (`sincronizarOmie` → edge `omie-sync-status-produtos`, que **não** registra server-side: 0 hits de `registro-execucao`), `src/hooks/useRefreshClientesNaoVinculados.ts:7-9` (`omie-analytics-sync`; a edge registra, o front não mostra). 9 arquivos já aderem; `AdminReposicaoPedidos` adere (4 hits).
Por que importa: "quando rodou pela última vez / deu certo?" some exatamente nas ações que o comprador dispara à mão.
Proposta: trocar por `useMutationComRegistro({ acao: 'reposicao.gerar-fila' | 'reposicao.sync-status-produtos' | 'analytics.sync-clientes' })` + `<UltimaExecucao acao>` nas telas.
I=2 · R=1 · E=1

**FE-14 | Fetch manual (`useEffect`+`useState`+`supabase.from`, sem react-query) em 7 páginas e 6 hooks; `Admin.tsx` é legado roteado-mas-não-linkado com `orders .select('*')` sem limite | código**
Evidência: páginas `FarmerCalls.tsx` (567: 22 `useState`, 5 `useEffect` L98-122, `.from` L144/153/190/226), `QualityChecklist` (335), `RecurringSchedules` (322), `AdminTraining` (305), `AdminPriceTable` (288), `AdminVendorSipCredentials` (249); hooks `useFarmerScoring` (698), `useFarmerExperiments` (434), `useBiometricAuth`, `useFarmerGovernance`, `useGamificationScore`. `src/pages/Admin.tsx` (336): `App.tsx:297` roteia `/admin`, a sidebar linka `/gestao/admin` (`AppShell.tsx:205`); só `useAdminOrderDetail.ts:179,295,314` faz `navigate('/admin')`; `Admin.tsx:66-67` `orders .select('*')` sem limite (fallback), 20 cores cruas, `KanbanBoard` (único consumidor).
Por que importa: cada um reimplementa loading/erro/cache; `Admin.tsx` concentra 3 achados (FE-03-like, FE-09, fetch manual) numa tela que a navegação já abandonou.
Proposta: decidir `Admin.tsx` (redirecionar `/admin` → `/gestao/admin` e apontar os 3 `navigate`; ou registrar por que fica); migrar `FarmerCalls` para `useQuery`/`useCustomerCalls` (hooks de call já existem: `useCallLog`, `useCustomerCalls`, `useLinkCallToCustomer`).
I=2 · R=2 · E=3

---

## Medições (grep, escopo acima, sem `ui/` e sem `*.test.*`)

| Métrica | Valor |
|---|---|
| Páginas / componentes / hooks / contexts | 172 / 525 / 178 / 10 |
| Arquivos ≥600 linhas no escopo | 16 (maior: `useRoutePlanner.ts` 1.456) · páginas ≥400: 30 |
| Cores cruas de status `(text|bg|border)-(emerald|red|…)-NNN` | 102 ocorr./33 arquivos (94/32 fora do adapter `StatusBadge`) · `*-status-*` = 2.326 |
| `<h1>` em pages | 130 · sem `font-display` 95 · `PageHeader` 0 · 126/126 páginas com `<h1>` manual |
| `useUrlState` em pages | 6 arquivos · páginas com `useState` de filtro/busca: 32 (46 ocorr.) |
| `<Loader2` em pages | 84 ocorr./50 arquivos — 1 resíduo de página inteira (`AdminReposicaoPromocaoDetail.tsx:392`) · `PageSkeleton` em 99 páginas |
| `keydown` solto | 6 (Escape/registry/edit-mode — desenho) · `posthog.` direto 0 · toast não-sonner 0 |
| `useMutationComRegistro` | 9 arquivos · `useMutation` cru em ação global: 3 arquivos (FE-13) |
| `queryKey` literal / via fábrica | 622 / 0 · `invalidateQueries` 278 (195 com 1 segmento; 0 sem chave) · `staleTime:` 187 (nenhum `0`) · `refetchOnWindowFocus:true` 0 · `refetchInterval` 14 |
| `.select('*')` | 155 ocorr./100 arquivos · 30 arquivos sem `.limit/.range/.single` · em tabelas grandes: `orders` ×3, `omie_products` ×1, `fin_contas_receber` ×1 |
| Fetch manual (`useEffect`+`.from` sem `useQuery`) | 7 páginas · 6 hooks |
| `ErrorBoundary` | 1 (global, `App.tsx:227`) · `Suspense` global 1 + 2 no shell |
| `catch {}` vazio | 1 (comentário) · `catch { // … }` 21 (localStorage/`onError` já tratou) · `.catch(() => {})` 3 |
| `EmptyState` | 20 páginas · 29 páginas com "Nenhum(a) …" literal sem `EmptyState` |
| Virtualização | `useVirtualizer` 3 · `useInfiniteScroll` 3 · `useInfiniteQuery` 2 · tabelas `.map` sem paginação: 11 páginas (2 sobre `omie_products` filtrado por tintométrico — pequeno) |
| Libs pesadas estáticas | recharts 14 arquivos (3 páginas analíticas) · leaflet 2 · framer-motion 7 · xlsx/jspdf 0 — **nenhuma em picking/recebimento/pedido** |
| Contexts com `value` memoizado | 9/9 que exportam value (`WebRTCCallContext.tsx:609`, `CompanyContext.tsx:68`, `AuthContext` 2 `useMemo`) |
| A11y | `div onClick` sem role: 11 (5 na mesma linha) · `<Input` 391 vs `<Label htmlFor` 187 · jsx-a11y: ausente |
| Testes | `src/pages/__tests__` 14 · `src/hooks/__tests__` 79 · co-localizado nos 6 hooks god-file: 0 |

---

## Descartei porque…

1. **Contexts causando re-render em cascata** — todos os 9 contexts que exportam `value` usam `useMemo` (`WebRTCCallContext.tsx:609-652`, `CompanyContext.tsx:68-85`); `ConditionalWebRTCProvider` não tem value. Não há cascata por identidade.
2. **`<Loader2>` de página inteira** — já entregue: `c18887a58` "Loader2 full-page → PageSkeleton em 61 páginas (auditoria 2026-07-06)"; `PageLoader` do `App.tsx:191` é `<PageSkeleton variant="auto">`; as 84 ocorrências restantes são spinners de botão (1 resíduo listado nas medições).
3. **Imports pesados em telas operacionais** — recharts só em `ToolReports/SavingsDashboard/AdminProductivity` + componentes analíticos; leaflet só `AdminRoutePlanner`/`RadarMapa`; framer-motion só dashboard do cliente + discador. Nada em picking/recebimento/`NewOrder`.
4. **Picking/Recebimento "desktop-only"** — é desenho documentado: `docs/ux-audit/01-inventario.md:122-123` declara `desktop` para `/recebimento`; a dual-view mobile do picking está pronta e **aguarda decisão do founder** (`04-execucao.md` §Decisões pendentes #19). Princípio 5 já está 🟡 no `mapa-do-app.md`.
5. **`keydown` solto / `posthog.` direto / toast não-sonner** — 0 posthog, 0 toast fora do sonner; os 6 `addEventListener('keydown')` são Escape-only (`HelpDrawer`, `ShortcutsDialog`), o próprio registry (`ShortcutsRegistry`) e o edit-mode guardado do `CockpitGrid` — infra dos atalhos, não vazamento.
6. **`catch` que engole erro** — os 21 `catch { // … }` são guards de `localStorage` (`useUnifiedOrder.ts:40-45`) ou "toast já disparado no `onError`" (`DividaFormDialog.tsx:233`); a classe perigosa (erro colapsado em vazio) já tem gate AST (`src/__tests__/erro-colapsado-em-vazio-gate.test.ts`) — o único caso vivo que encontrei está no FE-02.
7. **N+1 em listas / `invalidateQueries` amplo demais** — 4 componentes `*Card` têm `useQuery` próprio e nenhum é renderizado dentro de `.map(`; 0 `invalidateQueries()` sem chave; prefixo de 1 segmento é semântica do TanStack e `pedidos-ciclo` tem 4 escritores × 4 leitores coerentes. Polling do `AdminReposicaoMercado` (4×60s) pausa em background por default — custo baixo.
8. **`useMutation` cru em `SalesQuotes` (`omie-vendas-sync`)** — é conversão de UM orçamento (`convertToOrder`, `SalesQuotes.tsx:140`): "ação sobre UM registro: estado no próprio registro" (CLAUDE.md §DS), não ação global.
