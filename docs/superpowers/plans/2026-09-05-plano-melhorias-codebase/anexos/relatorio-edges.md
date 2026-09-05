# Auditoria read-only — `supabase/functions/` (edges + `_shared`) e `supabase/config.toml`

Data: 2026-09-05 · Worktree `intelligent-yalow-39d4e7` · Branch `claude/code-improvements-plan-2bc5f9`
Método: só leitura (`rg`/`find`/`awk`/`git log`), sem banco, sem executar edge/teste. Matriz bruta em `matriz.tsv` (mesmo diretório), gerada por `matriz.py`.
Números do enunciado (~4,8k/3,3k LOC) não bateram com o `wc -l` do worktree — reporto o medido.

## Panorama medido

- **95 edges** (96 pastas − `_shared`) · **64.581 LOC** de fonte nas edges (53.547 só em `index.ts`) · `_shared` **85 arquivos / 15.170 LOC** (42 fontes + 43 testes).
- **Testes Deno: 65 arquivos / 953 `Deno.test`** — 565 em `_shared`, 388 nas edges. **76/95 edges sem NENHUM teste. 0 testes importam um `index.ts`.**
- **Auth:** `config.toml` tem 49 entradas, todas `verify_jwt = false`; 46 edges sem entrada. Gate de aplicação: `_shared/auth.ts` (`authorizeCronOrStaff`) em 81 edges; **14 reimplementam o gate à mão**; 5 webhooks por segredo compartilhado; 3 só-JWT (customer-facing, com `ia-cota`); `mcp` (token do usuário, bundle gerado); `biometric-auth` (WebAuthn, público por natureza).
- **Sonda de versão:** 40/95 com `versao.ts` (40/40 no `sonda-fingerprints.ts` — consistente). **9 edges com cron e 17 chamadas pelo browser sem sonda.**
- **Registro de execução (`_shared/registro-execucao.ts`):** 3/33 edges com cron.
- **Invocadores:** 33 edges chamadas por cron (baseline `20260527230000` + migrations, 51 `net.http_post`, TODAS só com `x-cron-secret`, nenhuma com `Authorization`), 40 por `functions.invoke()` literal em `src/`, +12 via `src/lib/invoke-function.ts` (nome por variável), 5 via orquestrador `omie-cron-diario` (template `${name}`), 18 edge→edge.
- **Robustez:** 56 edges fazem `fetch`, **17 têm algum `AbortSignal`/`signal`**; `_shared/omie-deadline.ts` adotado por 5; `_shared/omie-paginacao.ts` (`proximoTotalPaginas`/`avaliarPagina`) por 14 — **0 loops crus por `total_de_paginas`**. `_shared/lease.ts`/claim em 11 edges. `waitUntil` em 6.
- **LLM:** 15 edges Anthropic direto (`claude-sonnet-4-6`, SDK `npm:@anthropic-ai/sdk@^0.93.0`), **0 no gateway Lovable**; `tool_choice` 15/15; `cache_control` 10/15; `usage` logado em 7/15; `zod` 0/15 (só o bundle `mcp`). 3 edges OpenAI (embeddings `rag-*`/`kb-ingest`). `ia-cota` em 5.
- **Observabilidade:** 825 `console.*` sem logger comum (0 helper de log em `_shared`); top: `omie-vendas-sync` 73, `omie-sync` 61, `enviar-pedido-portal-sayerlack` 61.
- **Dependências:** `npm:@supabase/supabase-js@2` em 86 imports; 1 `@^2` (`carteira-positivacao-snapshot/index.ts`); 1 `@^2.95.3` (`mcp`, bundle auto-gerado — deliberado). `Deno.serve` 95/95. Sem `deno.json`/import map (Lovable não usa).

---

## Achados (formato: ID | título | categoria | evidência | por que importa | proposta | I·R·E)

### E01 | Os 3 enumeradores Omie mais chamados por cron não têm teto de relógio no `fetch` | perf/robustez
- **Evidência:** `omie-vendas-sync/index.ts:231-237` — `for (attempt<=maxRetries=3)` com `fetch(OMIE_API_URL…)` sem `signal` (matriz: `timeout=0`; cron=6, browser=23, 4.339 LOC). `omie-analytics-sync/index.ts:204-210` — idem (cron=28, a edge mais agendada do repo). `omie-sync/index.ts` (cron=4, browser=6, `timeout=0`). `_shared/omie-deadline.ts:6` reconhece: "`omieCall` sem `AbortSignal.timeout` não tem teto de RELÓGIO" — adotado só por `omie-nfe-reconcile`, `omie-sync-estoque`, `omie-sync-nfes-recebidas`, `omie-sync-sku-items`, `omie-sync-vendas-items`. Total: 56 edges com `fetch`, 17 com algum timeout.
- **Por que importa:** `timeout_milliseconds` do cron mata a RESPOSTA, não o trabalho (`sync.md` §Padrão de cron). Omie pendurado consome as 3 tentativas em silêncio e o kill cai com `job_run_details=succeeded`; em `omie-vendas-sync` isso é money-path (pedidos/NF) com `sync_state` meio-escrito.
- **Proposta:** aplicar `timeoutRequestMs()`/`tempoRestanteMs()` de `_shared/omie-deadline.ts` no `omieCall` das 3 edges, com `MAX_DURACAO_MS` derivado do teto do cron de CADA uma (armadilha (a) do `sync.md`), e cobrir com a mesma `_test.ts` que as 5 adotantes já têm.
- **I=4 · R=3 · E=2**

### E02 | 15 edges constroem `new Anthropic({apiKey})` sem `timeout`/`maxRetries` (default do SDK: 10 min × 2 retries) | dependência/robustez
- **Evidência:** `rg "new Anthropic\("` → 15 `index.ts`; `rg "maxRetries|timeout:"` nesses 15 → **0**. `_shared/anthropic.ts:1-3` é deliberadamente sem SDK ("o cliente é construído na própria edge") — logo nenhum ponto central fixa isso. Ex.: `identify-tool/index.ts:133`, `melhoria-triagem/index.ts:223`.
- **Por que importa:** a edge morre por wall-clock (150 s cron / teto da plataforma) muito antes dos 10 min do SDK; sob lentidão da API, o SDK ainda re-tenta 2× → a morte é kill silencioso (sem passar por `traduzirErroAnthropic`), com a cota de `ia-cota` já debitada e sem resposta ao browser.
- **Proposta:** `_shared/anthropic-cliente.ts` (importa o SDK, FORA da suíte `--no-remote`) exportando `criarClienteAnthropic({timeout: 60_000, maxRetries: 1})`; trocar as 15 construções por ele (fatia mecânica; `sonda:bump` em cada uma das 7 instrumentadas).
- **I=3 · R=2 · E=2**

### E03 | `process-recurring-orders` cria `orders` a cada 10 min sem claim, sem chave de idempotência e avança `next_order_date` noutra transação | código/money-path
- **Evidência:** cron baseline: `'*/10 * * * *'` **e** `'0 7 * * *'` apontando para a edge. `process-recurring-orders/index.ts:17-23` seleciona `recurring_schedules` `is_active=true & next_order_date<=today`; `~:84` `from('orders').insert({user_id, items, …, notes:'Pedido automático…'})` — **sem `schedule_id` nem chave natural**; `~:104` `update recurring_schedules set next_order_date` só depois. `rg "lease|claim"` = 0; sem `versao.ts`, sem registro, sem teste (127 LOC). Nenhuma migration cria `UNIQUE` ligando `orders` a agendamento.
- **Por que importa:** falha entre o insert e o update (ou o 07:00 sobrepondo o `*/10`) gera pedido DUPLICADO — e como o pedido não carrega o `schedule_id`, a duplicata nem é detectável depois. É a classe "escrita parcial sem idempotência" em edge que fabrica pedido.
- **Proposta:** RPC SQL (`gerar_pedido_recorrente(schedule_id)`) com `SELECT … FOR UPDATE SKIP LOCKED` + insert + update na MESMA transação, coluna `orders.recurring_schedule_id` + `UNIQUE (recurring_schedule_id, next_order_date)`; a edge só enumera e chama a RPC. Nascer com `versao.ts` (E04). **Incerteza:** não medi se os DOIS crons estão ativos em prod (sem banco nesta auditoria) — o baseline versiona os dois.
- **I=4 · R=4 · E=3**

### E04 | 9 edges com cron e 17 chamadas pelo browser sem sonda de versão — incluindo escritas irreversíveis no Omie/WhatsApp | infra/observabilidade
- **Evidência (matriz):** cron sem `versao.ts`: `omie-sync` (cron 4 + browser 6, 1.676 LOC), `process-recurring-orders`, `enviar-push`, `dispatch-notifications` (cron 2 + browser 1), `omie-sync-metadados` (cron 3), `fin-ic-reconcile`, `cmc-snapshot-backfill`, `omie-nfe-recebimento-sync`, `omie-cron-diario`. Browser sem sonda com efeito externo: `omie-aplicar-parametros` (`index.ts:4,31` — `AlterarProduto` no Omie), `whatsapp-send`/`whatsapp-send-template` (mensagem enviada ao cliente), `tint-sync-agent`, `fin-regime-tributario`, `fin-valor-engine`. `rg probe` nessas = 0. `scripts/sonda-edge-nova-gate.ts:40-45` justifica as 55 não instrumentadas como "maioria leitura pura" — estas 8 escrevem.
- **Por que importa:** é exatamente a classe #2129/#2147/#2140 (deploy sem prova → `SEM_PROVA` no fecho). Edge chamada pelo browser não deixa linha em `net._http_response`; sem sonda, "está no ar?" só se responde executando o efeito real (um `AlterarProduto`, uma mensagem de WhatsApp).
- **Proposta:** 4ª leva de instrumentação restrita às 8 com escrita/efeito externo: `versao.ts` + `classificarSonda`/`criarRespostaSonda` ANTES do gate (padrão das NF-e), `bun run sonda:fingerprint -- --write`, linha na tabela do `deploy.md`. Leitura pura fica de fora (decisão #1767 mantida).
- **I=4 · R=2 · E=2**

### E05 | Nos 5 monólitos, ~2,5k LOC de lógica pura vivem no `index.ts` — que nenhum teste importa | arquitetura/teste
- **Evidência (heurística: função top-level sem `await`/`fetch`/`Deno.`/`.from(`/`.rpc(`):** `omie-financeiro` 31 funções puras / **767 LOC** (0 testes); `fin-cashflow-engine` 26 / **708** (0 testes); `omie-vendas-sync` 9 / 329; `omie-analytics-sync` 8 / 292; `disparar-pedidos-aprovados` 10 / 240 (0 testes); `enviar-pedido-portal-sayerlack` 6 / 144. Handler inline: `analyze-unified-order` **1.431 LOC dentro do `Deno.serve`** (linha 208→1638); `omie-vendas-sync` 1.516. `rg "from './index.ts'" *test.ts` = **0**. Money-path com 0 testes: `disparar-pedidos-aprovados`, `sayerlack-captura-precos`, `omie-financeiro`, `fin-cashflow-engine`, `fin-funding`, `fin-valor-engine`, `fin-ic-reconcile`, `fin-valor-cockpit`, `gerar-pedidos-diario`, `pedido-programado-enviar`, `process-recurring-orders`, `conciliar-pedido-portal`, `omie-sync-pedidos-compra`.
- **Por que importa:** o Deno só testa o que é importado; o padrão que FUNCIONA já existe ao lado (`omie-vendas-sync/pagination.ts` + `pagination_test.ts`, `assinatura-a2.ts`, `analyze-unified-order/saida-ia.ts`, `enviar-pedido-portal-sayerlack/qtde-portal.ts`) — as 6 edges acima têm 9 testes no total e todos são de módulos irmãos.
- **Proposta:** começar por `omie-financeiro` (classificação de títulos/data de baixa — 31 funções, DSO/DPO é money-path) e `fin-cashflow-engine` (projeção): mover funções sem `await` para `*.ts` irmãos com `_test.ts`; regra local "função sem IO não nasce no `index.ts`". Não reescrever handlers.
- **I=4 · R=1 · E=3**

### E06 | 25 wrappers `omieCall`-like locais, 22 leitores de credencial, 16 loops de retry, 12 `sleep` e 9 conversores de data — sem cliente Omie compartilhado | arquitetura/duplicação
- **Evidência:** `rg "async function (omieCall|callOmie|…)"` → 25 arquivos; `app.omie.com.br` literal em 27; `getOmieAccounts`/`OMIE_OBEN_APP_KEY` em 22 edges (`_shared/empresas.ts` só valida nomes); `const sleep =`/`function sleep(` em 12 edges, **nenhum em `_shared`**; `for (let tentativa…)` locais: 16; conversores dd/mm↔ISO em 9 pontos (`omie-financeiro/index.ts:1903,1915`, `sync-reprocess:128`, `omie-nfe-reconcile:333`…). `corsHeaders` definido localmente em 60 edges vs importado de `_shared/auth.ts` em 35. O `sync.md` registra o custo: #1614 corrigiu 4 wrappers, #1623 "parar no `!ok` deixou metade da classe viva" — cada regra de contrato Omie é aplicada N vezes.
- **Por que importa:** as peças PURAS já existem e são testadas (`omie-falha.ts` classifica faultstring/retentativa, `omie-deadline.ts` coleira, `omie-paginacao.ts` teto) — falta a composição com IO; sem ela, E01 se repete a cada edge nova e o gate de forma só pega o que está enumerado.
- **Proposta:** `_shared/omie-cliente.ts`: `omieCall(conta, endpoint, body, {deadline})` = fetch + `signal` + `!ok`/faultstring via `omie-falha` + retentativa via `atrasoRetentativaMs` + redação de segredo; migrar por leva começando pelas 3 do E01 (o `sonda:fingerprint` absorve o fan-out).
- **I=4 · R=2 · E=4**

### E07 | `config.toml` cobre 49/95 edges e NÃO descreve o gateway; a defesa real é o gate de aplicação — e 14 edges o reimplementam à mão | infra/segurança/documentação
- **Evidência:** 49 `[functions.x]`, todas `verify_jwt=false`; 46 edges sem entrada (default da CLI = `true`). Entre as 46 estão edges chamadas por cron **só com `x-cron-secret`** (baseline: 51 `net.http_post`, 0 com `Authorization`): `carteira-rebuild`, `omie-financeiro`, `pedido-programado-enviar`, `scoring-recalc-batch`, `visit-score-recalc-batch`, `tactical-plans-batch`, `fin-ic-reconcile`, `cmc-snapshot-backfill`, `carteira-positivacao-snapshot`, `reposicao-depara-sayerlack-auto` — e o `deploy.md` registra sonda de `carteira-rebuild`/`omie-financeiro` respondendo 200 em prod assim. Logo o gateway NÃO exige JWT nelas: o toml (42/50 commits do bot) é parcial e enganoso. Gate manual (lê `x-cron-secret` sem importar `_shared/auth.ts`): `disparar-pedidos-aprovados`, `enviar-pedido-portal-sayerlack`, `gerar-pedidos-diario`, `omie-sync-pedidos-compra`, `omie-sync-sku-items`, `omie-sync-nfes-recebidas`, `omie-sync-ctes-recebidos`, `omie-sync-vendas-items`, `omie-cron-diario`, `fin-valor-engine`, `fin-regime-tributario`, `fin-next-best-action`, `radar-ingest`, `biometric-auth`. Roles conferidos: todos `["employee","master"]` ou `master` — sem divergência HOJE.
- **Por que importa:** quem audita pelo toml conclui que 46 edges têm JWT no gateway e não têm; a única linha de defesa é código que existe em 15 versões (14 manuais + canônica) — a próxima mudança de role (ex.: `commercial_roles`) tem 15 lugares para esquecer.
- **Proposta:** (a) comentário-cabeçalho no `config.toml` + bullet em `deploy.md` §Edge: "o toml não é a verdade do gateway; auditar pelo gate"; (b) gate vitest de forma (mesma família de `edge-money-path-invariants.test.ts`): `index.ts` que lê `req.json()` E usa `SERVICE_ROLE_KEY` deve importar `_shared/auth.ts` ou estar em allowlist NOMEADA (webhooks, `biometric-auth`, `mcp`); (c) migrar as 14 para `authorizeCronOrStaff`/`authorizeMaster` (mecânico).
- **I=3 · R=2 · E=2**

### E08 | Registro server-side de execução em 3/33 edges com cron; 13 ações bilaterais (cron + clique) não registram em lado nenhum | observabilidade
- **Evidência:** `registro-execucao` importado por `analytics-outbox-drain`, `fin-cashflow-engine`, `omie-analytics-sync`. Frontend: `useMutationComRegistro` 7 usos (cobre `ai-ops-agent`, `omie-cliente`, `omie-sync-estoque`), `<UltimaExecucao>` 14 usos, `useUltimaExecucao.ts:33` lê SÓ `acoes_execucoes`. Bilaterais sem registro em nenhum lado: `disparar-pedidos-aprovados` (cron 3/browser 3), `gerar-pedidos-diario`, `pedido-programado-enviar`, `omie-vendas-sync` (cron 6/browser 23), `omie-financeiro` (cron 17), `omie-sync`, `sayerlack-captura-precos`, `calculate-scores`, `algorithm-a-audit`, `dispatch-notifications`, `monthly-report`, `omie-nfe-recebimento-sync`, `omie-sync-status-produtos`.
- **Por que importa:** CLAUDE.md fixa "edge single-shot com cron registra server-side"; sem isso o card mostra só cliques e a rodada de cron é invisível no painel. **Incerteza declarada:** várias têm sensor paralelo (`sync_state`, `fin_sync_log`, run-log da captura Sayerlack) — é ausência no PAINEL, não ausência de dado.
- **Proposta:** `comRegistro(db, slug, auth, fn)` nas 6 money-path (`disparar-pedidos-aprovados`, `gerar-pedidos-diario`, `pedido-programado-enviar`, `omie-vendas-sync`, `omie-financeiro`, `sayerlack-captura-precos`), tirando o escritor do frontend onde houver (1 escritor por slug).
- **I=3 · R=1 · E=2**

### E09 | LLM: 5/15 sem prompt caching, 8/15 sem log de `usage`, 0/15 com validação de schema da saída | código/custo
- **Evidência (matriz):** `cache_control`=0 em `analyze-services`, `copilot-analyze` (5 chamadas via `invokeFunction` — a mais usada pelo browser), `generate-bundle-argument`, `identify-tool`, `pedido-programado-extrair`. `usage.input_tokens` logado só em `compare-customer-process`, `structure-customer-process`, `promocao-extrair-via-vision`, `claude-spin-analyze`, `kb-extract-specs`, `analyze-unified-order` (+`prompt-sistema.ts`). `zod` só no bundle `mcp`; `_shared/anthropic.ts:72-91` extrai a tool, shape conferido à mão. Pontos fortes: `tool_choice` 15/15, `ia-cota` em 5 com gate `ia-paga-sem-cota-gate.test.ts`.
- **Por que importa:** custo por chamada não é estimável em 8 edges (só contagem de chamadas); nas 5 sem cache o `system` é pago inteiro a cada request.
- **Proposta:** `cache_control` no bloco `system` das 5; `registrarUsage(edge, usage)` puro em `_shared/anthropic.ts` (um `console.log` JSON com `edge/versao/input/output/cache_read`) chamado pelas 15; validação leve como `analyze-unified-order/saida-ia.ts` faz (campos obrigatórios + tipos) nas 4 que gravam saída no banco.
- **I=2 · R=1 · E=2**

### E10 | CLAUDE.md e `deploy.md` ainda descrevem o gateway Lovable/Gemini como "legado em uso" — 0 edges o usam | documentação
- **Evidência:** `rg "ai.gateway.lovable.dev" supabase/functions` → 0; `LOVABLE_API_KEY` só em comentários de migração (`promocao-extrair-via-vision/index.ts:6`, `generate-tactical-plan/index.ts:3`); commits `5a0f2192c`, `a6ef78bbf`, `06f11f2fd`. `CLAUDE.md:100` "legado usa o gateway Lovable/Gemini"; `deploy.md:67-75` seção inteira "teto MENSAL de créditos derruba 7 edges".
- **Por que importa:** a seção manda diagnosticar "quebra abrupta de IA = teto de créditos do gateway" — hoje o caminho real é o 402 da Anthropic (`traduzirErroAnthropic`), e a regra leva o diagnóstico para o lugar errado.
- **Proposta:** CLAUDE.md: "LLM em edge = Anthropic direto (15/15); gateway Lovable removido em 2026-07"; mover a seção do `deploy.md` para `docs/historico/` com a data.
- **I=2 · R=1 · E=1**

### E11 | `omie-sync` (1.676 LOC, 29 `case`, cron 4 + browser 6) é a pior linha da matriz: sem sonda, sem teste, sem timeout, sem lease, sem registro | arquitetura
- **Evidência:** matriz `omie-sync`: `V=-`, testes 0, `timeout=0`, lease ausente, `REG=-`; `rg 'case "'` = 29 actions num `index.ts` só; `total_de_paginas` usado como flag `omieTruncado` (`index.ts:393`, deliberado). O incidente #1623 (`sync_services` inativou todo serviço local) nasceu aqui (`sync.md`).
- **Por que importa:** é a interseção de E01/E04/E05 numa edge quente de escrita (clientes/serviços/OS) — mudar qualquer action hoje é sem prova de deploy e sem teste.
- **Proposta:** `versao.ts` agora (E04, E=1); depois quebrar as 29 actions em `acoes/<dominio>.ts` importáveis com teste, mantendo o `index.ts` como roteador.
- **I=3 · R=2 · E=3**

### E12 | Órfãs prováveis pelo lado do repo: `verify-employee` (333 LOC, chama Omie) e `gmail-webhook-receiver` (423 LOC, segredo sem dono) | higiene
- **Evidência:** `verify-employee`: única referência em `src/pages/TechnicalDocs.tsx:260` (tabela de documentação) + 2 gate-tests; não está em `invokeFunction`, cron, migration nem outra edge; último toque real 2026-07-29 (fix genérico G6). `gmail-webhook-receiver`: 0 refs em `src/`, `docs/`, `scripts/`, migrations (só `types.ts`); nasceu em commits "Changes" do bot (2026-04-24/25); exige `Bearer GMAIL_WEBHOOK_SECRET` que nenhum doc/runbook menciona; escreve `gmail_webhook_log`/`fornecedor_alerta`.
- **Por que importa:** edge deployada sem invocador ainda é superfície (SRK + body). O `deploy.md` exige provar os DOIS lados (repo E `net._http_response`/Lovable) e deletar no Lovable PRIMEIRO — este relatório prova só o lado do repo.
- **Proposta:** consultar respostas/logs dos 2 nomes (30 dias) via `psql-ro`; zero → delete no Lovable, depois PR removendo a pasta (+ `sonda-fingerprints` não muda: nenhuma é instrumentada).
- **I=2 · R=1 · E=1**

### E13 | Espelhos "manter sincronizado" sem parity test: `claude-spin-analyze` (prompt copiado de `src/lib/spin/spin-prompts.ts`) e `enviar-push` | teste
- **Evidência:** `claude-spin-analyze/index.ts:1-2` "System prompt INLINE (copiado de src/lib/spin/spin-prompts.ts … manter sincronizado)"; 9 `*.parity.test.ts` em `src/` cobrem 9 alvos (7 em `_shared`, `tint-import`, `fin-valor-cockpit`) — nenhum aponta para essas duas. 29 arquivos de edge carregam comentário de espelho; os demais são espelhos de `_shared` já cobertos ou de contratos vigiados por gate de forma.
- **Por que importa:** drift silencioso entre o prompt do frontend (SPIN) e o da edge — a classe que o mecanismo de parity existe para pegar, e ele escala (é `readFileSync` + comparação, ~30 linhas cada).
- **Proposta:** `src/lib/call/spin/__tests__/spin-prompt.parity.test.ts` e o equivalente para `enviar-push`, no molde de `costCompute.parity.test.ts`.
- **I=2 · R=1 · E=1**

---

## Quick wins (E≤2)
1. **E04** — `versao.ts` nas 8 edges de escrita sem sonda (começar por `omie-aplicar-parametros`, `whatsapp-send*`, `process-recurring-orders`, `omie-sync`).
2. **E01** — coleira `omie-deadline.ts` nos `omieCall` de `omie-vendas-sync`, `omie-analytics-sync`, `omie-sync`.
3. **E02** — `_shared/anthropic-cliente.ts` com `timeout`/`maxRetries` e troca mecânica nas 15.
4. **E10/E13** — doc do gateway para o histórico; 2 parity tests.

## Riscos sistêmicos
1. **Sem cliente Omie compartilhado (E06), cada regra de contrato é N correções** — E01 é o sintoma atual; #1614/#1623 foram os anteriores.
2. **A prova de deploy é opt-in (E04) e a auth é por convenção não vigiada (E07)** — as duas classes "verde por ausência de sinal" que o repo mais paga.

---

## Descartei porque…
1. **`total_de_paginas` confiado** — 14 edges usam `proximoTotalPaginas`/`avaliarPagina` de `_shared/omie-paginacao.ts`; loops crus = 0 (`omie-sync:393` usa como flag `omieTruncado`; `verify-employee` só declara o tipo). Entregue.
2. **Variantes de import do supabase-js** — 86/88 em `npm:@supabase/supabase-js@2`; `@^2.95.3` é o bundle `mcp` auto-gerado (deliberado, `ci-testes-edge-deno.md` §"Uma edge ficou de fora"); resta 1 `@^2` em `carteira-positivacao-snapshot` (trivial, sem comportamento). `Deno.serve` 95/95, 0 `deno.land/std/http` (família B #1685).
3. **`catch` que devolve 200** — o detector achou 15 ocorrências em 11 arquivos; TODAS são a resposta da sonda (`respostaSonda(VERSAO)`, 200 correto) ou resposta de batch com `errors[]` no corpo. Falso positivo.
4. **`Promise.all` sem limite** — `omie-sync:1627` usa `CHUNK`; `omie-cliente:290` itera 2 contas; `gmail-webhook-receiver:311` anexos de 1 e-mail; `fin-next-best-action:124` 2 empresas. Nenhum sobre lista grande.
5. **Edges "órfãs" (31 pela busca por `functions.invoke(` literal)** — 12 chegam por `src/lib/invoke-function.ts` (nome em variável: `copilot-analyze`, `identify-tool`, `elevenlabs-transcribe`, `nvoip-calls`, `kb-extract-specs`, `tint-omie-sync`, `tarefa-extrair-voz`, `rag-reindex`, `kb-ingest-document`, `generate-tactical-plan`, `generate-bundle-argument`, `analyze-services`); 5 são steps do `omie-cron-diario` (`index.ts:169-173`); 3 são webhooks externos (`omie-webhook`, `posthog-error-webhook`, `whatsapp-inbound`); `omie-sonda-recebimento`/`cmc-snapshot-smoke` são diagnósticas por SQL Editor; `tint-import` aposentada com gate (`retired_test.ts`); `omie-malha-sync` é a F1A do PCP (`docs/historico/pcp.md:10`, ações `probe/sync` manuais); `radar-ingest` via `scripts/` (3 refs). Sobraram as 2 do E12.
6. **Duplicata por versão (`-v2`/`-old`/`-legacy`)** — nenhuma por nome. `omie-nfe-recebimento-sync` × `omie-sync-nfes-recebidas` têm propósitos distintos documentados no header (cron horário com `maxPages=3` retomável × step do cron diário).
7. **Edges só-JWT sem role (`identify-tool`, `analyze-services`, `elevenlabs-transcribe`)** — customer-facing por desenho, medidas por `ia-cota` e vigiadas por `ia-paga-sem-cota-gate.test.ts`. `biometric-auth` sem gate de staff é WebAuthn (login) — verifica assinatura.
8. **Enumeração síncrona sem `waitUntil`** — `sync.md` documenta como deliberado (frontend espera `ok:true`; step de pipeline ordenado não pode responder 202).
9. **Gateway Lovable "legado"** — 0 edges; virou o achado de documentação E10, não de código.

---

## Medições — matriz edge × gate × sonda × registro × teste

Legenda: gate `CoS`=`authorizeCronOrStaff` · `C`=`authorizeCron` · `M`=`authorizeMaster` · `jwt`/`role`=verificação própria · `sig`=segredo de webhook · `srk-eq`=compara SERVICE_ROLE · `cron-man`=lê `x-cron-secret` à mão · cfg `vj=false`=entrada no `config.toml` (— = sem entrada) · `src`/`cron`/`e2e` = nº de invocações literais encontradas · `fetch/timeout` = ocorrências.

| edge | LOC | gate | cfg | sonda | reg | src | cron | e2e | fetch/timeout | testes |
|---|---:|---|---|---|---|---:|---:|---:|---|---:|
| ai-ops-agent | 454 | CoS,jwt,role | — | V+FP | — | 2 | 0 | 0 | 0/0 | 0 |
| algorithm-a-audit | 378 | CoS | vj=false | V+FP | — | 1 | 2 | 0 | 0/0 | 0 |
| analytics-outbox-drain | 418 | CoS | vj=false | V+FP | REG | 0 | 1 | 0 | 1/0 | 1 |
| analyze-services | 385 | jwt | — | — | — | 0 | 0 | 0 | 0/0 | 1 |
| analyze-unified-order | 2352 | CoS,jwt,role,sig | — | V+FP | — | 1 | 0 | 0 | 2/0 | 3 |
| biometric-auth | 240 | cron-man | vj=false | — | — | 1 | 0 | 0 | 0/0 | 0 |
| calculate-scores | 1123 | CoS,role | vj=false | V+FP | — | 1 | 2 | 0 | 0/0 | 1 |
| carteira-positivacao-snapshot | 201 | CoS | — | V+FP | — | 0 | 2 | 1 | 0/0 | 1 |
| carteira-rebuild | 815 | CoS | — | V+FP | — | 0 | 2 | 1 | 0/0 | 0 |
| cep-geo-resolver | 132 | CoS | — | — | — | 1 | 0 | 0 | 1/2 | 0 |
| claude-spin-analyze | 348 | CoS | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| cmc-snapshot-backfill | 352 | CoS | — | — | — | 0 | 2 | 2 | 1/0 | 0 |
| cmc-snapshot-smoke | 244 | CoS | — | — | — | 0 | 0 | 1 | 1/0 | 0 |
| compare-customer-process | 416 | CoS | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| conciliar-pedido-portal | 268 | CoS | — | V+FP | — | 1 | 0 | 0 | 1/0 | 0 |
| copilot-analyze | 332 | CoS,jwt | vj=false | — | — | 0 | 0 | 0 | 0/0 | 1 |
| deepgram-token | 82 | CoS | — | — | — | 0 | 0 | 0 | 1/0 | 0 |
| disparar-pedidos-aprovados | 1923 | CoS,jwt,role | vj=false | V+FP | — | 3 | 3 | 2 | 11/2 | 0 |
| dispatch-notifications | 400 | CoS,role | vj=false | — | — | 1 | 2 | 0 | 3/0 | 0 |
| elevenlabs-scribe-token | 80 | CoS,jwt | vj=false | — | — | 1 | 0 | 0 | 1/0 | 0 |
| elevenlabs-transcribe | 151 | jwt | vj=false | — | — | 0 | 0 | 0 | 1/0 | 0 |
| enviar-pedido-portal-sayerlack | 2797 | CoS,jwt,role,srk-eq | vj=false | V+FP | — | 0 | 5 | 1 | 4/2 | 1 |
| enviar-push | 172 | C | vj=false | — | — | 0 | 2 | 0 | 0/0 | 0 |
| extrair-sinais-ligacao | 224 | CoS | — | — | — | 1 | 0 | 1 | 0/0 | 0 |
| fin-cashflow-engine | 1488 | CoS,jwt,role,srk-eq | vj=false | V+FP | REG | 1 | 2 | 0 | 2/0 | 0 |
| fin-funding | 751 | CoS,M,jwt,role,srk-eq | — | V+FP | — | 1 | 0 | 0 | 3/2 | 0 |
| fin-ic-reconcile | 292 | CoS,jwt,role,srk-eq | — | — | — | 0 | 2 | 0 | 2/0 | 0 |
| fin-next-best-action | 180 | cron-man,jwt,role,srk-eq | — | — | — | 1 | 0 | 0 | 4/2 | 0 |
| fin-period-override | 148 | CoS,jwt,role,srk-eq | — | — | — | 1 | 0 | 0 | 2/0 | 0 |
| fin-regime-tributario | 592 | M,jwt,role,srk-eq | — | — | — | 1 | 0 | 0 | 2/0 | 0 |
| fin-suggest-mapping | 165 | CoS,jwt,role,srk-eq | — | — | — | 0 | 0 | 0 | 2/0 | 0 |
| fin-valor-cockpit | 777 | CoS,jwt,role,srk-eq | — | V+FP | — | 1 | 0 | 0 | 3/0 | 0 |
| fin-valor-engine | 400 | M,jwt,role,srk-eq | — | — | — | 1 | 0 | 0 | 2/0 | 0 |
| generate-bundle-argument | 655 | CoS,jwt | — | V+FP | — | 0 | 0 | 0 | 0/0 | 2 |
| generate-tactical-plan | 1230 | CoS,jwt | vj=false | V+FP | — | 0 | 0 | 1 | 0/0 | 2 |
| gerar-pedidos-diario | 486 | CoS,jwt,role | vj=false | V+FP | — | 1 | 3 | 0 | 3/0 | 0 |
| gmail-webhook-receiver | 423 | sig | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| identify-tool | 328 | jwt | vj=false | — | — | 0 | 0 | 0 | 0/0 | 1 |
| kb-extract-specs | 283 | M | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| kb-ingest-document | 199 | CoS | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| mcp | 78 | authhdr? | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| melhoria-triagem | 317 | CoS,role | — | — | — | 1 | 0 | 0 | 0/0 | 0 |
| monthly-report | 427 | CoS,jwt,role | vj=false | V+FP | — | 1 | 1 | 0 | 1/0 | 0 |
| nvoip-calls | 301 | CoS,jwt,role | vj=false | — | — | 0 | 0 | 0 | 7/0 | 0 |
| nvoip-sip-creds | 94 | CoS | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| omie-analytics-sync | 3023 | CoS,sig | vj=false | V+FP | REG | 4 | 28 | 0 | 1/0 | 1 |
| omie-aplicar-parametros | 199 | CoS | vj=false | — | — | 1 | 0 | 0 | 1/0 | 0 |
| omie-cliente | 1680 | CoS,jwt,role,sig | vj=false | V+FP | — | 10 | 0 | 0 | 2/2 | 0 |
| omie-cron-diario | 216 | CoS,jwt,role,srk-eq | vj=false | — | — | 0 | 1 | 0 | 4/3 | 0 |
| omie-financeiro | 2758 | CoS,jwt,role,sig | — | V+FP | — | 1 | 17 | 0 | 1/3 | 0 |
| omie-malha-sync | 264 | CoS | — | — | — | 0 | 0 | 0 | 1/0 | 0 |
| omie-nfe-recebimento | 728 | CoS,jwt,role | — | V+FP | — | 3 | 0 | 0 | 1/0 | 0 |
| omie-nfe-recebimento-sync | 427 | CoS | vj=false | — | — | 1 | 2 | 0 | 1/0 | 0 |
| omie-nfe-reconcile | 733 | CoS,sig | vj=false | V+FP | — | 0 | 2 | 0 | 1/3 | 0 |
| omie-nfe-webhook | 282 | CoS,sig | vj=false | V+FP | — | 1 | 0 | 0 | 0/0 | 0 |
| omie-sonda-recebimento | 1127 | CoS | vj=false | — | — | 0 | 0 | 0 | 1/0 | 1 |
| omie-sync | 1676 | CoS,role | vj=false | — | — | 6 | 4 | 0 | 2/0 | 0 |
| omie-sync-ctes-recebidos | 691 | CoS,jwt,role | vj=false | V+FP | — | 0 | 0 | 0 | 3/2 | 0 |
| omie-sync-estoque | 1049 | CoS | vj=false | V+FP | — | 1 | 7 | 0 | 2/5 | 0 |
| omie-sync-metadados | 259 | C | vj=false | — | — | 0 | 3 | 0 | 1/0 | 0 |
| omie-sync-nfes-recebidas | 1126 | CoS,jwt,role | vj=false | V+FP | — | 0 | 0 | 0 | 3/3 | 1 |
| omie-sync-pedidos-compra | 1240 | CoS,jwt,role | vj=false | V+FP | — | 0 | 0 | 0 | 3/2 | 0 |
| omie-sync-sku-items | 1180 | CoS,jwt,role | vj=false | V+FP | — | 0 | 1 | 0 | 3/2 | 0 |
| omie-sync-status-produtos | 727 | CoS | vj=false | V+FP | — | 2 | 2 | 0 | 1/2 | 1 |
| omie-sync-vendas-items | 720 | CoS,jwt,role | vj=false | V+FP | — | 0 | 0 | 0 | 3/2 | 0 |
| omie-vendas-sync | 4339 | CoS,jwt,sig | vj=false | V+FP | — | 23 | 6 | 1 | 1/0 | 2 |
| omie-webhook | 247 | sig | vj=false | — | — | 0 | 0 | 1 | 0/0 | 0 |
| pedido-programado-enviar | 513 | CoS | — | V+FP | — | 1 | 3 | 0 | 1/0 | 0 |
| pedido-programado-extrair | 237 | CoS | — | — | — | 1 | 0 | 0 | 0/0 | 0 |
| posthog-error-webhook | 123 | sig | vj=false | — | — | 0 | 0 | 0 | 0/0 | 0 |
| process-nfe | 552 | CoS,jwt | vj=false | V+FP | — | 1 | 0 | 0 | 1/0 | 0 |
| process-recurring-orders | 127 | C | vj=false | — | — | 0 | 2 | 0 | 0/0 | 0 |
| promocao-extrair-via-vision | 1022 | CoS | vj=false | — | — | 0 | 0 | 1 | 0/0 | 1 |
| radar-ingest | 156 | CoS,jwt,role | vj=false | — | — | 0 | 0 | 0 | 0/0 | 0 |
| rag-reindex | 242 | CoS | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| rag-search | 133 | CoS | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| recommend | 651 | CoS,jwt,role | — | V+FP | — | 3 | 0 | 0 | 0/0 | 0 |
| reposicao-depara-sayerlack-auto | 189 | CoS | — | V+FP | — | 0 | 1 | 1 | 0/0 | 0 |
| sayerlack-captura-precos | 1280 | CoS | vj=false | V+FP | — | 1 | 2 | 0 | 1/2 | 0 |
| scoring-recalc-batch | 206 | CoS | — | V+FP | — | 0 | 2 | 1 | 2/0 | 0 |
| scoring-recalc-client | 522 | CoS | — | — | — | 0 | 0 | 1 | 0/0 | 0 |
| sinais-batch | 118 | CoS | — | — | — | 0 | 0 | 1 | 1/0 | 0 |
| structure-customer-process | 141 | CoS | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| sync-reprocess | 1303 | C,sig | vj=false | V+FP | — | 0 | 4 | 0 | 1/0 | 2 |
| tactical-plans-batch | 420 | C | — | V+FP | — | 0 | 1 | 1 | 1/0 | 0 |
| tarefa-extrair-voz | 107 | CoS | — | — | — | 0 | 0 | 0 | 0/0 | 0 |
| tint-import | 113 | CoS | vj=false | — | — | 0 | 0 | 0 | 0/0 | 1 |
| tint-omie-sync | 256 | CoS | vj=false | — | — | 0 | 0 | 0 | 1/0 | 0 |
| tint-sync-agent | 965 | S,jwt,role | vj=false | — | — | 2 | 0 | 0 | 0/0 | 1 |
| verify-employee | 333 | CoS,jwt,role | vj=false | — | — | 0 | 0 | 0 | 1/0 | 0 |
| visit-score-recalc-batch | 222 | CoS | — | V+FP | — | 0 | 2 | 1 | 2/0 | 0 |
| visit-score-recalc-client | 509 | CoS | — | — | — | 0 | 0 | 1 | 0/0 | 0 |
| whatsapp-inbound | 223 | sig | vj=false | — | — | 0 | 0 | 0 | 0/0 | 0 |
| whatsapp-send | 67 | CoS | vj=false | — | — | 2 | 0 | 0 | 1/0 | 0 |
| whatsapp-send-template | 192 | CoS | — | — | — | 1 | 0 | 0 | 1/0 | 0 |

> Nota: `src` conta só `functions.invoke("<nome>")` literal; +12 edges chegam por `invokeFunction()` (variável) e 5 por template no `omie-cron-diario` — ver "Descartei" #5. Arquivo bruto com as 25 colunas: `matriz.tsv`.
