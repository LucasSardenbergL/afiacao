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

## Desfecho: mergeou só em 2026-08-06 (#1212), 566 commits depois

O PR ficou **4 semanas parado em conflito** — não-draft, mas `CONFLICTING`, estado em que o auto-merge nunca dispara. Quando foi destravado, 4 dos 8 conflitos eram a `main` tendo feito a mesma faxina por outro caminho (`getPosthog`, `clearOfflineQueue`, `useCustomerOrders` e o `backfill-helpers.ts` inteiro já haviam sumido de lá), e **um inverteu de sinal**: `EdgeFunctionError` era dead export em julho e hoje tem 6 consumidores e campos novos (`status`/`retryAfterSeconds`) — aplicar a des-exportação quebraria o build. O `invoke-function.ts` precisou de resolução dividida: `AuthRequiredError` des-exportado, `EdgeFunctionError` mantendo o `export`. Sobra sobre a `main` de hoje: **116 arquivos / 821 deleções** (era 132 / 990). Narrativa completa e a lição geral em [prs-parados-2026-08-06.md](prs-parados-2026-08-06.md).

## Re-faxina 2026-08-07: o exit 0 do #1212 durou 21 minutos

No dia seguinte ao merge, `bunx knip` já acusava **64 achados** (2 deps + 27 unused exports + 35 unused exported types) + 2 configuration hints. Não foi bump de versão (`knip` é `^6.14.0` declarado e resolveu 6.14.0), não foi mudança de config, e o #1212 não mentiu — **ele mediu exit 0 contra uma base que já estava morta**. As datas provam: todo símbolo reintroduzido nasceu DEPOIS de 2026-07-07 (`FAMILIA_FOLHA` #1243 em 09/07, `TOLERANCIA_CROSSCHECK` #1339 em 16/07, `AUTHZ_CONTRATO_MATRIZ` #1434 em 19/07, `SYSTEM_ESSENCIAL` #1618 em 29/07), e o último — `dedupeKeyProposta` (#1332) — entrou às **13:31 do dia 06/08, 21 minutos antes do #1212 mergear às 13:52**.

**A lição, que generaliza para qualquer gate fora do CI:** a medição de um gate não-CI **expira**, e a validade dela é a distância entre medir e mergear. `knip` roda no health stack local, não no `validate` — então nenhum dos 566 commits da janela foi barrado, e a faxina chegou na `main` já vencida. Um gate de CI verde é um fato sobre a `main`; um gate local verde é um fato sobre o *seu worktree, naquele instante*. Corolário prático: faxina de dead code deve ser medida e mergeada no mesmo dia, ou o `exit 0` do commit é folclore.

**Decisões de fronteira desta rodada** (as demais foram des-exportação mecânica ancorada em `arquivo:linha`, 49 automáticas + 4 barris manuais):

- **`_shared/embalagem-captura-helpers.ts` → ignore documentado**, mesmo precedente do `sayerlack-sku.ts`. O arquivo é espelho byte-exato de `src/lib/reposicao/embalagem-captura-helpers.ts` (parity test `__tests__/embalagem-captura-helpers.parity.test.ts`). `TOLERANCIA_CROSSCHECK`, `parseBRL`, `diaSaoPaulo` etc. têm consumidor no `src` (testes vitest) e nenhum no edge: des-exportar no edge quebra a paridade, replicar no `src` quebra os testes. Os exports órfãos do espelho são o preço da byte-identidade. Os 2 tipos que o knip flagou nos **dois** lados (`ResultadoLeitura`/`FonteLeitura`, com uso interno em `LeituraEmbalagem`) foram des-exportados simetricamente, com o `diff` provando que a paridade seguiu intacta.
- **Barris**: nos 4 casos o knip flagou o **re-export**, não a origem. `mensagemRecusasAtp` e `dedupeKeyProposta` seguem exportados no módulo (têm consumidores que importam direto); só `EnviarPropostaParams`/`EnviarPropostaResult` saíram também na origem, por perderem ali o único consumidor externo.
- **`jsr` fora do `ignoreDependencies`**: os 5 `jsr:` que restam no repo são **comentários** explicando que `--no-remote` proíbe import remoto. Os imports reais morreram nas migrações família A/B (#1685/#1687/#1690). `npm:` continua necessário — e o knip não reclamou dele, o que confirma a leitura.
- **`useWhatsappPendentes.ts` fora do `ignore`**: hoje tem consumidor real (`useFilaAcoes.ts`); o obsoleto era o ignore.
- **`papaparse` + `@types/papaparse`**: zero ocorrências em todo o repo versionado — nem import estático, nem dinâmico, nem em script/JSON/MD. (Seguem no `package-lock.json`, que é fóssil no repo: o lockfile vivo é o `bun.lock`.)

**Política adotada: des-exportar, não deletar.** Remover o `export` não altera comportamento algum e só *reduz* alcance, o que neutraliza por construção a regra do money-path ("não pergunte quem chama, pergunte o que acontece se alguém chamar") — uma função com efeito destrutivo e sem chamador fica menos alcançável, não mais. Delete só entraria onde o `noUnusedLocals` do tsc strict provasse órfão, e não foi o caso de nenhum dos 64.
