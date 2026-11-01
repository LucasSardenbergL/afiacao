# Auditoria de performance — 4 ondas + follow-up (2026-07-04)

Varredura de performance/responsividade do app inteiro (5 lentes em paralelo: providers/contextos, data fetching, bundle, re-renders, telas operacionais) → build medido → **5 PRs**. Todas frontend puro (sem migration/edge). As 3 mudanças de risco (Onda 3, Onda 4, P1-c) passaram por **revisão Codex**, que pegou bug real em cada uma (detalhe abaixo — é o valor da disciplina money-path→Codex).

## Diagnóstico (o que a auditoria achou)

Fundação boa: 215 rotas lazy, vendors bem fatiados, precache PWA enxuto, PostHog/WebRTC lazy. Ganhos reais em 4 frentes: (1) telefonia vazando pro boot, (2) contexts re-renderizando a árvore inteira, (3) over-fetch/waterfall no data layer, (4) tabelas grandes sem virtualização + timers re-renderizando páginas.

## As entregas

| PR | Onda | O que | Ganho |
|---|---|---|---|
| #1160 | 1 | `AppShellLayout`: `CallCopilotHud`/`TransferSpikePanel` → `React.lazy` + gate staff + `requestIdleCallback`; `IncomingCallModal` fica **eager** (caminho de atender chamada). `useMemo`/`useCallback` no value de `AuthContext`/`CompanyContext`/`WebRTCCallContext`/`DashboardEditModeContext`. `gcTime` 15min. `BrowserRouter future.v7_startTransition`. `jsdom`/`vitest`/`@testing-library` → devDependencies. | **framer-motion (~41KB gzip) fora do boot** — provado nos bytes (sumiu do modulepreload); entry 75,6→72,2KB gzip (~13% do caminho crítico). Fim do re-render de árvore inteira por render de provider. |
| #1163 | 2 | Timers isolados em componentes `*Live` (`AdminReposicaoPedidos` 60s; cronômetro `FarmerCalls` 1s) — `dataHoje` com bailout (setState com mesma string). Virtualização (`useVirtualizer`) das tabs `ContasReceberTab`/`ContasPagarTab` (até 1.000 títulos → só linhas visíveis). `CallListPanel` `React.memo`. `AppSidebar`/`AppTopbar`/`MobileNav` `React.memo` + handlers estáveis no `AppShell`. | tick de relógio não re-renderiza mais ~500 pedidos; financeiro sem os ~9.000 nós DOM; shell imune a re-renders com props estáveis. |
| #1167 | 3 | Projeções: `useIcMatches` (colunas do type, não `*`), `useRoutePlanner` (orders). Paralelização: chunks de profiles do `useExcecoesGestor` (`await` série → `Promise.all`). Optimistic no `RecebimentoConferencia` (`setQueryData` no confirmUnit). | menos bytes/latência; contador de conferência sobe na hora em vez de esperar refetch (300-800ms). |
| #1168 | follow-up P1-c | `registerOfflineHandler` ganha `invalidateKeys` por kind; `useOfflineFlush` (agora com `useQueryClient`) revalida os kinds que drenaram. | o que o operador confirma offline aparece ao reconectar (antes só no próximo refetch natural). |
| #1169 | 4 | PWA `registerType: 'prompt'` (era `autoUpdate`+`skipWaiting`); `injectRegister: false`; `clientsClaim` mantido; `src/lib/pwa-update.ts` (toast "Atualizar"); guard `__PWA_ENABLED__` + fallback de registro em `main.tsx`. Modelo durável: `docs/agent/deploy.md`. | fim do reload-surpresa no meio do turno do conferente. |

## Bugs que o Codex pegou (e eu tinha introduzido)

- **Onda 3** — o optimistic rodava mesmo com a mutação **enfileirada offline** (`mutateAsync` resolve `null`, não persistiu). Pior: `canFinalize` deriva do cache → o operador poderia **efetivar a NF-e no Omie sobre unidade não persistida** (hazard de estoque). Fix: escopar o otimismo a `persisted = result !== null` (só sucesso online); offline volta ao caminho honesto. Também trocou a leitura stale de `confirmMutation.queued` pelo retorno.
- **Onda 4** — removi `clientsClaim` junto com `skipWaiting` por associação → quebraria offline-first no **1º acesso** (SW não controla a aba até um reload). E o registro do SW ficou atrás de um import dinâmico sem fallback → se o chunk falhasse, **app sem SW**. Fix: restaurar `clientsClaim`, fallback `navigator.serviceWorker.register('/sw.js')` no catch.

Padrão: nas duas, a 1ª review achou o P1, corrigi, re-review confirmou "SEGURO PRA MERGE". Sem a revisão, teria ido hazard de estoque e app sem offline pro chão de fábrica.

## Lições de método (não repetir)

- **`bun lint` no conjunto COMPLETO de arquivos tocados** antes do push, não só typecheck+teste. A Onda 4 falhou o 1º CI por um `prefer-const` no `pwa-update.ts` que eu não lintei (só rodei eslint nos arquivos do outro PR). typecheck e build não pegam regra de estilo.
- **`queryKey` com objeto inline NÃO é bug no react-query v5** — ele hasheia a key estruturalmente (dois achados de agente descartados como falso-positivo na Onda 1).

## Deploy

As 5 são **frontend** → precisam de **Publish do frontend no Lovable** (nenhuma migration/edge). A Onda 4 tem uma **transição única**: clientes com o SW antigo (autoUpdate) auto-recarregam **uma última vez** ao pegar o build com modo prompt; daí em diante, toda atualização vira o toast. Inerente à troca.

## Onda 5 — SDKs de voz/OCR fora dos chunks de página (2026-07-07, PR #1211)

Maior chunk do app era a página `FarmerCopilot` (478,77 kB raw / 126,31 kB gzip): `useFarmerCopilot.ts` importava `@elevenlabs/react` (useScribe) ESTATICAMENTE — o SDK de voz baixava só para ABRIR a página (vendedor externo em 4G). Menor, mesmo padrão: `tesseract.js` estático no `LoteScannerOCR` (dentro do chunk da `RecebimentoConferencia`, tela precacheada).

**Fix**: useScribe é hook (não pode ser condicional) → o corte é o componente **headless** `MotorVozScribe` (retorna null; connect no mount / disconnect no unmount, refs "latest", guards single-fire), montado via `React.lazy` só ao iniciar sessão de voz — o chunk baixa em PARALELO ao roundtrip do token, e falha de download cai no fallback voz→texto já existente. A UI da sessão **não** foi movida (é compartilhada com o modo texto, o fallback). No scanner, `createWorker` virou dynamic import no `capture()` (1º scan). **Armadilha que a auditoria não via**: sem `vendor-elevenlabs`/`vendor-tesseract` nomeados (manualChunks, precedente do vendor-posthog) + `globIgnores`, o **precache do PWA baixaria o SDK de voz para TODO usuário** na instalação do SW.

**Medido nos bytes**: FarmerCopilot 478,77→23,72 kB raw (−95%; gzip 126,31→7,52); RecebimentoConferencia 34,79→21,44 kB; `vendor-elevenlabs` 455,53 kB (só no clique); `vendor-tesseract` 16,33 kB (só no 1º scan); precache 5.486→5.474 KiB. Provas estruturais: 0 import estático do vendor no chunk da página (única menção = array de deps do `__vitePreload`), 0 `modulepreload` no boot, 0 menção no `sw.js`.

**Codex pegou de novo (3 achados em 3 rodadas, todos corrigidos)**: (1) erros fatais por EVENTO pós-`connect()` (auth/quota) deixavam a sessão de voz "surda" sem fallback → handlers fatais específicos; o agregador `onError` do SDK foi deliberadamente evitado (dispara também para transientes — throttle/silêncio derrubariam a sessão à toa); (2) toast "Copiloto ativado" saía no `connect()` resolvido, que pode preceder o OPEN real → sucesso sinalizado só por evento (`onConnect`/`onSessionStarted`, single-fire); (3) troca de token com o motor montado vazaria guards entre conexões → `key={token}` no call-site (1 instância = 1 conexão). Lição repetida das Ondas 3/4: **em ciclo de vida de conexão, a review independente paga**.

## Plano v4, lote 3 (C1): recharts fora da home staff (2026-11-01)

O `@hello-pangea/dnd` (CockpitGrid da home staff, KanbanBoard do Admin) importava do `vendor-charts` (recharts+d3, 111 KB gzip) só dois helpers: `_extends` (`@babel/runtime`) e `invariant` (`tiny-invariant`, via `css-box-model`; o recharts também depende dele). Sem bucket no `vendorChunk`, o Rollup alojava os dois no vendor-charts, e o hoist de imports transitivos levava `import"./vendor-charts…"` para o chunk de cada tela que usa o dnd. Correção: os dois pacotes vão para o `vendor-utils`, como o `clsx` em 2026-06-09.

O diagnóstico do plano citava só o `@babel/runtime`. Com essa regra sozinha o build não mudou: o `invariant` vinha de outro pacote. A conferência pelo `import{…}from"./vendor-charts"` do chunk do dnd, antes e depois, foi o que achou. Lição: ao mexer em bucket, meça no chunk importador quais símbolos ele ainda importa de lá, não só o tamanho dos vendors.

Medido (fecho de imports estáticos via `vite build --manifest`, gzip -9): home staff 165,1 → 53,8 KB além do entry; Admin 154,6 → 43,4 KB; entry 283,7 → 283,9 KB; `vendor-utils` 6,9 → 7,1 KB; chunks com vendor-charts no fecho 13 → 10, e os 10 importam componentes de gráfico.
