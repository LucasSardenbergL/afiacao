# Auditoria health/convenções — 2026-07-06

Auditoria mecânica completa (health stack + 2 sweeps por padrão do CLAUDE.md: convenções UI e padrões perigosos money-path). Complementar à `revisao-completa-2026-07-04.md` (que mapeou bugs comportamentais por domínio — backlog de lá segue válido e em ataque pelas worktrees dedicadas). Precisão > recall.

## Dashboard (baseline → pós-correção)

| Check | Antes | Depois |
|---|---|---|
| typecheck (tsc strict) | ✅ 0 erros | ✅ 0 erros |
| test (vitest) | ✅ 4602/4602 | ✅ 4602/4602 (+1 flaky corrigido) |
| build (vite, gate CI) | ✅ | ✅ |
| lint (eslint) | ✅ 0 errors · 79 warnings | ✅ 0 errors · 78 warnings |
| knip (dead code) | ❌ 362 linhas (17 files, 72 deps fantasma, 5 hints) | 🟡 254 linhas (0 files, 0 deps, 0 hints — só exports/types = sinal real) |
| shellcheck | ✅ 0 | ✅ 0 |

## Corrigido nesta sessão

- **Flaky money-path**: `SalesQuotes.priceGuard.test.tsx` — timeout do teste era 15s mas `findByRole`/`waitFor` usavam default de 1s; sob suíte completa (jsdom saturando a M2 8GB) o 1s estourava. Timeout folgado propagado aos waiters internos.
- **Dead code real deletado** (0 referências, confirmado import-a-import): `KbDocumentForm.tsx` + `useUploadKbDocument.ts` (substituídos pelo batch upload), `RankingTable.tsx` (negociação paralela), `src/lib/radar/types.ts`.
- **Deprecação StatusBadge concluída**: consumidores migrados do alias `StatusBadgeSimple` (deprecated) para `StatusBadge`; alias removido (era o único uso — situação invertida do que o `@deprecated` sugeria).
- **knip.json reescrito** — falsos positivos estruturais zerados: `src/lib/mcp/index.ts` é FONTE do bundle gerado `supabase/functions/mcp` (plugin Vite) → entry; `src/test/bun-setup.ts` é preload do `bunfig.toml` (runner bun nativo) → entry; `supabase/functions/**/*_test.ts` são testes Deno → entry; `use-mobile.tsx` é par do sidebar shadcn (vendored) → ignore; `ignoreDependencies: ["npm"]` (specifier `npm:` do Deno parseado como pacote); hints obsoletos removidos.
- **`fast-glob` declarado** em devDependencies (testes de impersonação a importam direto; vinha só transitiva).
- **eslint-disable órfão** removido (`WebRTCCallContext.tsx`).
- **Dormentes intencionais documentados no knip.json** (ignore): `NvoipDialer`/`useNvoipCall` (descontinuados da interface, "mantidos p/ revert fácil" — comentário em `useCallBackend.ts`), `useWhatsappPendentes` (infra pronta p/ feature futura — comentário em `useFilaAcoes.ts`).

## Falsos positivos descartados (não mexer — razões provadas)

- `dre-helpers.ts:127` `valorCaixaEfetivo` — o `?? 0` alimenta só a comparação `> 0`; null degrada pro valor de documento (decisão #396, espelhada no engine).
- `approvalSuggestion.ts:30-32` — todo null degrada para modo `review` (fail-closed por design); nenhum caminho auto-aprova com dado ausente.
- `omie-vendas-sync:2613` gate de crédito — `|| 0` SUBESTIMA `totalAtualOmie` → gate dispara MAIS (fail-closed); trecho com veredito Codex.
- `.or()` interpolado em edge functions (omie-financeiro, fin-valor-cockpit) — exceção documentada no `eslint.config.js`: datas computadas internamente, não input.
- `fin_dre_snapshots` sem `.limit()` — 12 linhas/ano/empresa/regime; precisaria ~80 anos p/ capar em 1000.
- Somas com `?? 0` em reduce (cashflow saldo_cc/cmv_ttm, fluxo-realizado) — somar 0 ≡ excluir da soma; mudar semântica é decisão de produto, não fix.

## Lote 2 (mesma sessão, pós-merge do PR da auditoria)

Faxina de unused exports em módulos FRIOS (excluídos: financeiro, reposição, vendas/salesOrders, sayerlack, KB — áreas quentes ou com PR draft). 26 exports resolvidos (74→48): 17 símbolos de uso interno perderam só o keyword `export` (formatDocument, TIERS, RETRY_DELAY_MS, classifyProfile, AGENDA_TIPOS, TRACKED_PREFIXES, ORDER_STATUS_INVALIDOS, AuthRequiredError, EdgeFunctionError, PATHS_EXTRAS_SALES_ONLY, CADENCIA_DEFAULT, pickTopModifier, signalsCount, scoreNome, OPTIMISTIC_MSG_PREFIX, fetchCidadesRota, fetchWhatsappSla); 7 símbolos completamente mortos deletados (useInsideAppShell, calculateSharpeningStats, getPosthog, clearOfflineQueue, OUTCOME_STATUSES, WEAR_LEVELS, e 3 hooks de useOrders: useCustomerOrders/useStaffPendingOrders/useCustomerCount). Método: knip garante 0 usos externos; grep no próprio arquivo distingue uso interno (≥2 ocorrências) de morto total (1); typecheck strict (noUnusedLocals) valida.

**Achado**: `omie-sync-status-produtos/paginacao.test.ts` usa sufixo `.test.ts` (vitest-style) mas vitest só inclui `src/**` — o arquivo só roda via `deno test` manual (documentado no cabeçalho). knip.json agora cobre ambos os sufixos de teste Deno (`*_test.ts` e `*.test.ts`) e ignora o specifier `jsr:` (mesmo caso do `npm:`).

## Backlog novo (fora do escopo seguro desta sessão — churn alto/multi-worktree)

- ~78 usos de cores Tailwind hardcoded (`text-emerald-600` etc.) onde a convenção v3 pede `text-status-*` — concentrados em páginas de status/governança/farmer. Migração visual dedicada.
- ~52 `<Loader2 spin>` de página inteira onde a convenção pede `<PageSkeleton>`.
- 39 warnings `react-hooks/exhaustive-deps` (padrão legado loadData+useEffect; correção certa = migração react-query por tela) + 25 `react-refresh/only-export-components`. Warnings NÃO bloqueiam o CI de propósito (decisão documentada no ci.yml; contagem caiu 82→78, ratchet não se aplica).
- 74 unused exports + 180 unused types (agora 100% sinal real no knip) — faxina de `export` keyword em sessão dedicada.
