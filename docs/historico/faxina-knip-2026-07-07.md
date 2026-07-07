# Faxina knip → exit 0 (gate de dead code) — 2026-07-07

Sessão dedicada prevista no backlog da [auditoria 2026-07-06](auditoria-health-2026-07-06.md): zerar os 74 unused exports + 180 unused exported types (sinal 100% real após o saneamento do knip.json). A partir daqui, `bunx knip` com exit 0 é o **gate de regressão de dead code** do health stack — qualquer export novo sem consumidor aparece.

## O que foi feito

- **Des-exportação em massa ancorada no knip** (não sed cego): script que só transforma a linha exata reportada (`arquivo:linha` + nome + forma `export const/function/type/interface/class`); qualquer outra forma (re-export, deslocamento) vira SKIP para tratamento manual. Rede de segurança dupla: tsc strict (`noUnusedLocals`/TS6196) denuncia des-exportado sem uso interno real → convertido em delete.
- **Deletes reais** (0 consumidores, confirmados): hooks mortos de `useOrders` (`useCustomerOrders`/`useStaffPendingOrders`/`useCustomerCount`), módulo de permissões/conciliação nunca consumido do `financeiroV2Service` (`getTodasPermissoes`/`upsertPermissao`/`deletePermissao`/`PERFIL_DEFAULTS`/`getSyncLogs`/`getConciliacaoPendente`/`resolverConciliacao`), `omieService` (`checkOmieClient`/`listOmieServices`/`listOmieContasCorrentes`/`syncOmieServices`), `getDREConsolidado`, `calculateSharpeningStats`, `getPosthog` (reforça a convenção `track()`-only), `clearOfflineQueue`, `IgnorarDialog`, `useInsideAppShell`, tipos-resquício do domínio afiação (`Address`, `WEAR_LEVELS`) e aliases `fin_*` sem consumidor no `financeiroTypes`.
- **Constantes money-path** (thresholds documentais em `src/lib/financeiro/*`: `COBERTURA_MIN_EMPRESA`, `TTM_MESES_MIN`, `PLAUSIBILIDADE_TETO_DIAS`, `EPSILON_MONETARIO`, `VALUE_DELTA_REVIEW_THRESHOLD` etc.): **des-exportadas, não deletadas** — seguem no arquivo documentando o threshold ao lado do uso.

## Decisões de fronteira (por que NÃO mexer)

- **`supabase/functions/_shared/sayerlack-sku.ts` → ignore documentado no knip.json.** O parity test (`sayerlack-sku.parity.test.ts`) exige **byte-identidade** com o canônico `src/lib/reposicao/sayerlack-sku.ts`, cujos exports são importados pelo teste vitest — des-exportar no edge quebraria a paridade; no src, quebraria o teste. Os "exports sem consumidor" do edge são o preço da paridade byte-exata.
- **`cost-compute.ts` (edge) × `costCompute.ts` (src)**: `CostSourceComUnidade` flagado NOS DOIS lados → des-exportado **identicamente nos dois** (o parity test normaliza só a linha de import; o resto segue byte-idêntico).
- **`titulo-status.ts`**: `OPEN_NOT_OVERDUE_TITLE_STATUSES`/`SETTLED_TITLE_STATUSES` des-exportadas; o guard de paridade TS↔SQL cobre só `OPEN_TITLE_STATUSES` (intocada).
- **mutcheck**: needles dos `.mut` são trechos INTERNOS de corpo de função — des-exportar declarações não dessincroniza contrato nenhum (conferido needle a needle nos 9 `.mut` que cobrem arquivos tocados).
- **`paginacao.test.ts` (1º teste de edge, Deno)**: knip acusava unused file porque o entry só cobria `*_test.ts`. Correção na CONFIG (entry `supabase/functions/**/*.test.ts`), não rename — Deno aceita ambos os padrões e docs/comентários referenciam o nome atual.
- **Multi-worktree**: `gh pr list` + diffs conferidos antes — nenhum dos 4 PRs abertos (#1204/#1139/#947/#928) toca arquivo da faxina nem menciona símbolo removido (grep no diff dos 2 PRs de domínio próximo).

## Verificação

- `bunx knip` → **exit 0** (era exit 1 com 254 linhas).
- `heavy bun run typecheck` → 0 erros (strict, inclui `noUnusedLocals` — é ele que prova que nenhum des-exportado ficou órfão).
- `heavy bun run test` → suíte completa verde (inclui os parity tests byte-exatos e o guardrail money-path textual).
- `bun lint` → 0 errors.
