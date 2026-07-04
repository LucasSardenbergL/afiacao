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
