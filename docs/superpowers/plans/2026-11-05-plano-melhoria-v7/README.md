# Plano de melhoria v7 — fila de aprovação honesta, KPIs de reposição, caixa da colacor e escopo da main (2026-11-05)

> Levantamento em 3 eixos por varreduras Fable (app: código das telas ativas · banco/edges em prod por `psql-ro` · dev/CI por `gh run`), uma **busca independente do Codex** (sem ver a lista do Fable) e uma **contestação do Codex** sobre a lista consolidada, com conferência minha no código e na prod.
> Codex: busca=gpt-6-astra·high·196.385 tokens · contestação=gpt-6-astra·high·145.047 tokens. Pareceres crus: [anexos/codex-busca-independente.md](anexos/codex-busca-independente.md) · [anexos/codex-contestacao.md](anexos/codex-contestacao.md).

## 0. Fecho do v6

Os lotes executáveis do [v6](../2026-11-04-plano-melhoria-v6/README.md) estão mergeados (conferido por `gh pr view` em 2026-11-05 ~15:30 UTC):

- **Entregues:** lotes 1 C1/A4 (#3612 + sonda #3620), 2 C2+C4 (#3611, histórico #3615), 3 C5 (#3619), 4 C6 (#3616), 5 F9 (#3623), 6 E9+E10 (#3617) e F8 (#3610, Publish conferido no #3627). Também saíram o #3634 (DES ao vivo sem faturado) e o #3618, que fechou o resíduo do F7: `useCommercialRole` lê o cargo do cache, de 8 para 1 REST.
- **Diagnosticados:** D6 (#3625), D8 (#3628), F11 (#3629, descartado por lab A/B, com o conserto do `fin_period_overrides`).
- **Descartados com medida:** E13 (#3622) e D9 (#3609).
- O #3633 (status do v6) segue **aberto** e não colide com este arquivo.

**Bundle servido** (`https://steu.lovable.app`, 2026-11-05 ~15:20 UTC): `app-commit-sha=5ab78cba` (#3635), build 14:27:19Z. Todos os PRs de tela do v6 estão no ar, **menos o #3634**: ele mergeou às 14:27:09Z, 10 s antes do build, e ficou de fora (`git log 5ab78cba..80c74384b` = só o #3634).

Fica em aberto o que depende de data, amostra, plataforma ou founder:

| Item | Estado (medido hoje) | Quando / critério |
|---|---|---|
| **#3634: Publish + migration manual** | ✅ **APLICADO** (2026-11-05, pedido do founder). Migration `20261105091216` pelo `db:aplicar`: ensaio com ROLLBACK verde, depois **tentativa #906 → recibo**. 2ª testemunha (`psql-ro`): `md5(pg_get_viewdef)` = `02a50869…` (o da POS1), `security_invoker=on`, e 3 das 4 linhas sem faturado com **0 gap fabricado**. Front no ar: o bundle servido (`app-commit-sha=ba6fc062`) traz o gate `fat_bruto_confirmado !== null && posicao_ao_vivo_conservadora !== null` no chunk `AdminDesTrimestreAtual-DBG1nxdN.js` | — |
| D5/B1: DROP dos índices sem uso dos scores | Inalterado: `idx_radar_muni_cover` 150 MB, `lista_estab` 58, `lista_novas` 43, `idx_health_history_customer` 104 + `_farmer` 25, `idx_priority_log_customer` 65 + `_farmer_date` 17, `idx_tint_formulas_nome_cor` 81 — todos `idx_scan=0` (~543 MB). Os 4 dos scores **pesam no DELETE do expurgo** sem servir leitura | Releitura a partir de **2026-11-07 10:33 UTC**, na sessão `v5-d5-b1-indices`, que já existe. O Radar tem uso mensal: não decidir DROP com menos de um ciclo. O `idx_radar_muni_cover` já tem PR **draft** de outra sessão (#3639, migration do founder) |
| B1: expurgo semanal | Job 196 (`30 4 * * 0`, `expurgar_scores_antigos(60, 10000)`) rodou em 01/11 04:30 (37 s, succeeded). Restam **464.310 linhas > 60 d** em cada tabela de score. O teto da função (60 × 10 k) cabe | 1ª passada com 60 d em **2026-11-08 04:30**. Conferir `cron.job_run_details` (jobid 196) e `count(*) FILTER (WHERE calculated_at < now()-'60 days')` |
| Web-vitals dos lotes de tela | `telemetria_vitals`: 200 linhas, **1 `user_id`**, 33 builds desde 02/11 | ~2026-11-09, separando por build adotado. A data não garante amostra |
| F2: TTFB | Mesmo sensor, com 1 usuário | Reabre com amostra de mais de 1 usuário |
| B3: HOT de contas a receber | `fin_contas_receber`: 280.672 upd e 37 HOT desde o restart, quase todos do bootstrap de 03/11. Em 05/11 houve 1.364 updates. O de contas a pagar fez **98,5% HOT** no 1º ciclo pós-apply ([histórico](../../../historico/hot-contas-pagar-lote11.md)) | ⏸️ Reabrir se voltar a ≥ ~30 k updates/dia |
| E11: escopo dos `falsificacao` | Fila p90 dos PRs **0,9 min** (geral 4,1), contra 17,5 no v5 | ⏸️ Reabrir se a fila voltar ao p90 do v5 |
| Lote 9 do v5: merge queue | 🚧 Bloqueado pela plataforma: repo de conta pessoal ([histórico](../../../historico/ci-merge-queue-bloqueada-repo-pessoal.md)) | — |
| `pg_stat_statements` | Teve **reset global** às 14:13:13 UTC de hoje (`pg_stat_statements_info.stats_reset`); com ~50 min de janela, "top por tempo" é ruído | Ler em **2026-11-07** (D11; e o Radar depois do #3638) |

## 1. Como ler

- **Medido**:
  - `psql-ro` em prod, com contadores de **5,2 d** desde o restart de 2026-10-31 10:33 UTC (`n_live_tup` pós-restart não é tamanho: no v6 isso gerou o D9 falso);
  - `gh run`, **33 runs** do `ci.yml` depois do #3617 (05/11 11:16 → 14:27 UTC; 23 verdes, 2 com provas em PR). A amostra é curta: re-medir com ≥ 30 PRs antes de fixar o p50 "com provas";
  - `net._http_response` guarda só **6 h** (`pg_net.ttl`): falha de edge mais antiga que isso não aparece nessa fonte.
- **Estimado** = ganho em ms ou min; é hipótese até medir.
- Veredito final = meu, depois do Codex. ✔ = conferi no código ou na prod.
- Os sensores de uso continuam com 1 usuário. Itens F valem pelo **laboratório antes/depois**; itens C não esperam adoção quando o defeito é reproduzível numa tela **ativa** do manifesto.

## 2. Itens, um a um

### C. Correção e dinheiro honesto

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| C7 | **APROV-FANTASMA** — a fila de aprovações e o KPI da home contam cliente importado do Omie como cadastro pendente | ✔ `omie-cliente/index.ts:1331-1337`: o import no servidor (#3496/#3501/#3511) insere o `profile` **sem `prospect_source`**. Os dois leitores excluem fantasma por `prospect_source.neq.omie_import` (`AdminApprovals.tsx:55-61`, `useSistemaZone.ts:48-55`). ✔ Prod (`psql-ro`): **0** perfis com `omie_import`; **16.070** com `is_approved=false`, todos com `prospect_source` nulo e **16.070/16.070** em `omie_customer_account_map`; 10.406 nasceram em 01/11 17:41–23:51 UTC. A home afirma ~16 mil aprovações pendentes, e a fila (sem `.range()`, `created_at desc`) mostra 1.000 fantasmas: um cadastro real fica afogado. Sem risco de escalada: o ramo de master por documento não existe mais em `auto_assign_user_role` (✔ `pg_get_functiondef`) | AJUSTAR: o corte é **escritor + backfill por procedência**. Marcar `omie_import` só no perfil **criado** pelo import, nunca no perfil real reaproveitado por documento (`:1311`). Os 16.070 são o conjunto candidato, não a prova: cruzar com o usuário Auth placeholder (`is_placeholder: true`, `:1319`) e tratar divergências à parte. **Cortar** o filtro "não está no mapa Omie" como regra: o mapa prova vínculo comercial, e o próprio import vincula perfis preexistentes (`:1353`; `AdminApprovals.tsx:177`) | **MANTER** (M) — deploy de edge + backfill de dado no envelope ou pelo founder (o `claude_ro` não lê `auth`) + Codex. Sem tocar aprovação, papéis nem aliases fiscais |
| C8 | **CAD-ZERO** — os 3 KPIs de `/admin/reposicao/cadastros` mostram zero em falha | ✔ `AdminReposicaoCadastros.tsx:44,59,68,85` `if (error) return 0`; o render (`:95-110`) usa `?? 0` e tom neutro, ou seja, "SKUs sem cadeia logística: 0" = "tudo mapeado". ✔ "Histórico de ciclos" `:253` vira lista vazia em erro. O anti-join no cliente (`:50-72`) lê duas listas sem paginação, mas hoje não trunca (✔ `sku_parametros` ativos OBEN 588, `sku_grupo_producao` 392) | AJUSTAR: estados distintos de carregando, falha e zero medido, **também no render**. `COUNT … NOT EXISTS` no banco é melhoria opcional, não condição: os volumes não sustentam truncagem hoje. Se entrar, preservar empresa+SKU, `ativo=true` e permissões. A dívida de paginação já está na baseline (`single-shot-truncado-gate.test.ts:81`) | **MANTER** (P) |
| C9 | **MERC-PROMO** — "Promoções vigentes" mostra zero em falha | ✔ `AdminReposicaoMercado.tsx:66-67` `if (error) return 0` e `:134` fixa `unavailable: false` | AJUSTAR: a premissa de que os 3 irmãos estão certos é **parcialmente falsa**. Eles levam `unavailable`, mas o render imprime `c.value` sempre (`:164`) e só acrescenta "Sem dados disponíveis" (`:165-166`), ou seja, zero com ressalva. Corrigir o render comum: indisponível → `—` com o motivo | **MANTER** (P), no lote de C8 |
| C10 | **OPP-ERRO** — as oportunidades de compra afirmam economia R$ 0 em falha | ✔ `AdminReposicaoOportunidades.tsx:106-119`: a query lança, mas o consumidor faz `data: oportunidades = []` sem estado de falha; as somas partem de zero (`:218-237`) e `OportunidadesTable.tsx:34-35` mostra o estado vazio. Reprodução do Codex: erro simulado → **0 linhas, economia 0**, idêntico ao controle `[]` com sucesso | MANTER: reaproveitar o `estadoDeLeitura` que a própria página já usa (`:95-103`) para KPIs **e** tabela; falha de atualização com dado anterior é marcada como desatualizada | **MANTER** (P) |
| C11 | **MELH-BADGE** — o badge de melhorias abertas some em falha | ✔ `useMelhorias.ts:150-162` `if (error) return 0`, poll de 60 s | AJUSTAR: trocar `0` por `null` **não muda nada**, porque `AppShell.tsx:595-596` só desenha o badge com valor positivo (como `useAlertasCriticos.ts:13-15` assume). Escolher um contrato completo, sem sistema global de alertas | **MANTER** (P), prioridade abaixo de C7–C10, no lote de C8 |

### F. Velocidade do app

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| F13 | **HOME-DND** — a home staff baixa o arrastar-e-soltar fora da edição | ✔ `CockpitGrid.tsx:2` importa `@hello-pangea/dnd` estático e `:72` monta o `DragDropContext` sempre (`isDragDisabled` só desliga). Bundle isolado da lib: ~31 KB gzip (medida do Codex). O lab do #3607 mostrou que no mobile **o gargalo é o chunk do dashboard** | MANTER: separar a grade editável em módulo sob demanda; confirmar no build e na rede que a home deixou de alcançar o DND (o `KanbanBoard.tsx:3` também usa). Não reatribuir o ganho do `vite.config.ts:365-370`, que já tirou o recharts da home. Os 31 KB isolados não são economia garantida | **MANTER como experimento** (M) — lab antes/depois, com 1ª entrada na edição, teclado, reordenação e persistência; Publish |
| F12 | **C360-PARALELO** — margem do Customer 360 espera o score | ✔ `customer360/hooks.ts:81-102`: score próprio → fallback → só então `buscarMargemScore`, que só precisa do cliente (`margemScores.ts:63-65`). Os `error` das duas leituras de score são descartados | AJUSTAR: o ganho é a sobreposição, não "−1 RTT", e cliente sem score passa a gerar uma chamada de margem antes dispensada. O fallback só roda quando a leitura própria teve **sucesso sem linha**; o consumidor (`Customer360.tsx:127`) precisa ver o erro | **MANTER** (P) — lab com os 3 casos (próprio, fallback, ausência legítima); Publish |

### E. Dev e CI

Base nova (✔ `gh run`, 33 runs do `ci.yml` depois do #3617, 3h11 de janela): **sem provas p50 7,1 / p90 8,7 min**, 39 runner-min (v6: 8,4; o shard do E10 cumpriu); **com provas p50 24,3 / p90 26,6**, 145 runner-min (v6: 23,6, sem ganho visível). Caminho crítico com provas = `provas-sql-uniao` em 10/10, com pior parte p50 19,0 (v6: 20,2). Sem provas, `edges-e-build` é o último em 8/13. Fila de PR p90 0,9 min; **0 flaky, 0 attempt > 1, 0 falha**. A amostra é curta (só 2 PRs com provas): re-medir com ≥ 30 PRs.

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| E16 | **N=7** — 7 partes no núcleo SQL | ✔ Matriz com 6 partes (`ci.yml:1152`); a união já é genérica (`:1462`). Pior parte p50 19,0 contra 16,4 previstos pela LPT; o [histórico do #3617](../../../historico/ci-lote6-v6-lpt-remedido-e-shard-vitest.md) deixou N=7 como opção | MANTER: experimento. 19,0 contra 16,4 **não prova desbalanceamento**, porque a variação entre runners é forte. Medir parede até o `validate`, fila p90 e runner-min, além da pior parte. Considerar o trabalho exclusivo da parte 1 (`:1393`). Sem balanceador novo | **MANTER como experimento** (P) — ganho de −2 a −2,5 min é hipótese; +1 job no teto de 20 concorrentes |
| E14 | **ESCOPO-MAIN** — o dispatch pós-merge roda as 6 partes mesmo depois de merge só-docs | ✔ `provas-sql-escopo.ts:166-168` roda tudo fora de `pull_request`; `auto-merge.yml:118` dispara o `ci.yml` na main a cada merge. 8 de 13 merges do dia foram só-docs, e cada dispatch custa ~145 runner-min, 3,7× o PR. A fila do dispatch (p90 5,9 min) é a pior do CI | AJUSTAR: reabre **estreito**, não o E2 inteiro (o v5 cortou tirar as provas do dispatch). Só para **diff cumulativo exclusivamente documental**, contra uma base ancestral cujas provas **e a união** terminaram verdes ("workflow verde" pode ser prova pulada), comparada com o SHA fixo do run. Base desconhecida, não ancestral ou diff inconclusivo → roda. O `validate` só aceita o skip em `pull_request` (`ci.yml:1501-1515`): adaptar junto, com os testes. **Não** estender a allowlist do PR à main (`provas-sql-escopo.ts:18-20`; [ci-provas-sql-escopo.md:39](../../../historico/ci-provas-sql-escopo.md)). Ganho ≈ 106 runner-min por run elegível, não 145 | **MANTER restrito** (M) — depois do E16, para não misturar medidas |
| E17 | **RADAR-ESPERA** — esperas fixas numa prova concorrente | ✔ `db/test-radar-cadastro-conflitos.sh:239,469`: 7 retenções de 2 s por passagem, com controle e 15 sabotagens no `--falsificar` (custo 360 s em `db/nucleo-ci-custo.txt:101`) | AJUSTAR: as pausas seguram transações enquanto o teste observa o bloqueio (`:228-245`, `:472-476`). **Não** só encurtar o sleep: liberar ao observar o bloqueio, com timeout de falha. Os 20–30 s estimados estão mal fundamentados; segundos numa prova não viram segundos no `validate` | **EXPERIMENTO** (M), depois de E16 e E14, sem misturar ganhos |

### D. Banco e edges

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| D10 | **CR-MAPA** — o snapshot de caixa da colacor saiu sem o cenário realista em 05/11 | ✔ `fin_projecao_snapshots` (`psql-ro`): 02–04/11 com os 3 cenários nas 3 empresas; **05/11 colacor só com otimista + pessimista**. `net._http_response` às 10:05: HTTP 500 `Leitura de fin_titulo_baixas_cr_mapa falhou (código 57014)` (v2.2). A RPC sozinha mede ~3,9 s, com spill de ~575 blocos de temp, sob o `statement_timeout` de 8 s. Recorrência: 10 dias com menos de 3 cenários em 10–20/10, antes do escalonamento por empresa (`20261020120100`, crons 10:00/10:05/10:10), e hoje. ✔ `_shared/baixas-cr.ts` falha fechado (correto: ausente ≠ zero) | AJUSTAR: `fin-cashflow-engine/index.ts:414-439` carrega o mapa em cada `carregarDados`, e `:1371` repete por cálculo; o cron enfileira 3 cenários por empresa (`20261020120100…sql:52-60`). **Cortar** o cache por empresa/dia (frescor e invalidação num caminho financeiro). Fazer **1 carga de dados por execução dos 3 cenários**, compartilhada na invocação e mantendo o contrato de cenário único. `work_mem` local é experimento, não causa provada. Preservar a guarda de equivalência da RPC com a view (`20261019110100…sql:61-66`). A persistência é `INSERT` (`:1416`): retry em lote não é idempotente | **MANTER — prioridade máxima** (M) — money-path: prova PG17 + comparação financeira dos 3 cenários + Codex + **deploy de edge**. Conferir o ciclo de 06/11; o snapshot de 05/11 só é refeito para o cenário faltante, sem re-rodar o cron em lote |
| D11 | **GDH** — `_data_health_compute()` ficou 10× mais lento com o mesmo trabalho | `_data_health_compute()` hoje: **2.106 ms, 81.856 buffers, 0 do disco**; o D6 mediu ~229 ms com os mesmos ~82 k buffers e deixou IO da instância como hipótese ([d6](../../../historico/d6-watchdog-diagnostico-v6.md)). Polling de 120 s, só no badge de master/gestor (`useDataHealth.ts:17-18`, `DataHealthBadge.tsx:18-20`) | AJUSTAR duas premissas: **já existe** índice `(action, status, completed_at DESC)` em `fin_sync_log` (`20261101201804…sql:44-45`), e no corpo versionado `cron.job_run_details`/`net._http_response` aparecem em **mensagens**, não em leituras (`20261031191715…sql:212-214`). Identificar o corpo vivo antes. 0 blocos lidos não prova CPU nem contenção | **DIAGNÓSTICO** (P) — por trecho, read-only, em 3 horários, só o compute puro (nunca o watchdog com efeitos). Trio acoplado preservado |

## 3. Cortes

| # | Item | Por quê |
|---|---|---|
| C12 + MAP-SALVAR + MAP-ESCOPO | Mapeamento do aumento: famílias cortadas em 1.000 linhas (✔ 85 famílias, 75 nas 1.000 primeiras), salvar sobre leitura desconhecida com DELETE e INSERT separados (`MapeamentoDialog.tsx:63-72,131-165`), e "específicos" vazio gravando família inteira (`:145-157`) | Defeitos reais e conferidos (os 2 últimos são acréscimos da contestação), mas a superfície **nunca foi usada**: ✔ `fornecedor_aumento_anunciado` = 0, `fornecedor_aumento_item` = 0, `categoria_aumento_familia_mapeamento` = 0. Sem aumento anunciado, o diálogo nem abre. Reabrir quando o 1º aumento for anunciado, num lote só (distinct no servidor + substituição transacional + escopo explícito) |
| D12 | Radar: `radar_empresas` com 12,3 M `heap_blks_read` em 5,2 d | **Em voo em outra sessão**: o #3638 tira a releitura diária de `radar_empresas` (~6,4 GB/dia), e o #3639 (draft) apaga o `idx_radar_muni_cover`. Medir de novo depois deles, com o `pg_stat_statements` de 07/11. Mesmo assim, `heap_blks_read` não é byte físico (cache do SO) |
| — | C7 pelo filtro "não está no mapa Omie" | O mapa prova vínculo comercial, não ausência de pedido de acesso: esconderia cliente real vinculado (Codex, ✔ `omie-cliente/index.ts:1353`) |
| — | D10 por cache do mapa por empresa/dia | Frescor intradiário e invalidação num caminho financeiro; a carga compartilhada na invocação resolve sem isso |
| SLA-5000 | `useSlaFornecedor.ts:46-50` com `.limit(5000)` | ✔ `v_sku_sla_compliance` OBEN = 607 linhas: sem perda hoje. Reabrir com crescimento ou ao tocar a leitura |
| — | Truncagem do histórico de ciclos (`AdminReposicaoCadastros.tsx:245-263`) | ✔ `pedido_compra_sugerido` OBEN = 784 linhas. O erro → `[]` da mesma leitura entra no lote de C8 |
| — | Confiabilidade do cockpit (`useFinanceiroCockpit.ts:74-93`, 3 leituras em série que ignoram o erro) | ✔ `fin_confiabilidade` = 0 linhas, e a tabela está na lista de jamais escritas do [plano de 2026-09-05](../2026-09-05-plano-melhorias-codebase/anexos/tabelas-jamais-escritas.txt) (M-42). Não otimizar leitura sem produtor |
| MAP-EMPATE | Sugestão DRE escolhendo `matchesByCode[0]` entre empresas (`fin-suggest-mapping/index.ts:118`) | ✔ `fin_categoria_dre_mapping`: 157 linhas, 157 códigos, **0 conflitantes** (só colacor e `_default`). Latente; reabrir quando uma 2ª empresa mapear |
| — | Histórico de ligações do farmer (`FarmerCalls.tsx:166-176`) | ✔ `farmer_calls` = 0 linhas, telefonia congelada |
| E15 | `sonda:cron-prova` fora do só-docs | −0,7 min de parede; só faria sentido junto do E11, que segue ⏸️ com fila p90 de 0,9 min |
| — | `useMyKpis.ts:32` (erro → "R$ 0,00 hoje") | Sem consumidor fora dos testes: código morto |

Os cortes do v5 (E6, D2, E2, E8, F6, E4) e do v6 (C3, D7, F10, NF-NULL, NF-CHAVES, E12, D4-res, `useAdminOrderDetail`, ESLint de `?? 0`) continuam valendo. O E14 reabre só a fatia documental do E2, com o fato novo (escopo implementado e custo medido), e o E2 inteiro segue cortado. Os candidatos menores do D4 do v5 (os 26 `has_role` meio embrulhados, o InitPlan de `cap_carteira_ler`, a busca pontual da carteira) seguem sem sinal: "quando tocar a tabela".

## 4. Roadmap em lotes

| Lote | Conteúdo | Depende de | Quem aplica |
|---|---|---|---|
| 1 | D10 — 1 carga de dados por execução dos 3 cenários na `fin-cashflow-engine` | — | sessão + prova PG17 + Codex + **deploy de edge**; conferir o ciclo seguinte em `fin_projecao_snapshots` |
| 2 | C7 — import marca a origem do perfil criado + backfill por procedência | — | sessão + Codex + **deploy de edge** + **backfill** (envelope ou founder no SQL Editor) |
| 3 | C8 + C9 + C10 + C11 (+ erro do histórico de ciclos) — estados honestos nos KPIs de reposição e no badge | — | sessão + **Publish** |
| 4 | ~~E16 — 7 partes no núcleo SQL, medido~~ ✅ #3643, **mantido**: pior parte 16,5 e 15,9 min (base p50 19,3, mín. 18,6 em 17 runs), parede até o `validate` 17,3 e 16,6 (base p50 23,0), runner-min empatado (145,4 e 146,2 sem o mutcheck; base p50 146,1). Fila não medida sob carga ([histórico](../../../historico/ci-e16-nucleo-sql-7-partes.md)) | — | sessão |
| 5 | E14 restrito — escopo documental cumulativo no dispatch da main | lote 4 medido | sessão + Codex |
| 6 | F13 — DND sob demanda na home | lab antes/depois | sessão + **Publish** |
| 7 | F12 — score e margem em paralelo no Customer 360 | lab antes/depois | sessão + **Publish** |
| — | E17 | lotes 4 e 5 medidos | experimento |
| — | D11 | — | diagnóstico read-only, sem PR de código |
| — | D12 | #3638/#3639 | outra sessão |
| — | ~~#3634 Publish + migration~~ ✅ aplicados em 2026-11-05 (ver §0) | — | — |

Os lotes 1, 2, 3, 6 e 7 tocam arquivos distintos e são independentes entre si. 4 → 5 → E17 rodam em sequência para não misturar a medição do CI. Antes de cada lote, procurar o artefato na main (`git grep <símbolo> origin/main`): no meio da escrita deste plano, outra sessão abriu o #3638/#3639 sobre o Radar, que este levantamento também tinha achado.
