# Plano de melhoria v6 — dinheiro honesto nas telas ativas, boot, CI e diagnóstico de banco (2026-11-04)

> Levantamento em 3 eixos por varreduras Fable (app: telemetria + código · banco/edges em prod por `psql-ro` · dev/CI por `gh run`), uma **busca independente do Codex** (sem ver a lista do Fable) e uma **contestação do Codex** sobre a lista consolidada, com conferência minha no código.
> Codex: busca=gpt-6-astra·high·190.968 tokens · contestação=gpt-6-astra·high·138.390 tokens. Pareceres crus: [anexos/codex-busca-independente.md](anexos/codex-busca-independente.md) · [anexos/codex-contestacao.md](anexos/codex-contestacao.md).

## 0. Fecho do v5

Os lotes executáveis do [v5](../2026-11-03-plano-melhoria-v5/README.md) estão mergeados (conferido por `gh pr view` em 2026-11-05 00:20 UTC):

- lotes 1 UTI (#3566), 2 HST (#3563), 3 E5+E7 (#3565), 4 BND+F4 dedup (#3562; a RPC única foi descartada com medição no #3575), 6 F1+F5 (#3579), 6b (#3603) e 6c (#3607), 7 F3 (#3581), 8 CI-GIT+E1 (#3585/#3589), 10 D3 fatia 1 (#3588) e 11 D1 em contas a pagar (#3591);
- o lote 5 (VAL-IO) está com a edge no ar;
- o D4 teve diagnóstico (#3595), medida (#3602) e conserto (#3604), aplicado na prod pela tentativa #898. As leituras do farmer caíram de 1,3–1,9 s para ~10 ms ([histórico](../../../historico/rls-carteira-visibilidade-por-conjunto.md)).

Fica em aberto o que depende de data, amostra ou plataforma:

| Item | Estado | Quando / critério |
|---|---|---|
| D1 (lote 11): HOT em contas a pagar | `fillfactor=80` e índice do carimbo aplicados, mas **0 HOT** até agora (156.935 upd). O único ciclo depois do apply caiu no mesmo instante da aplicação | Ciclo das **08:00 UTC de 2026-11-05**. Medir o **delta** de `n_tup_hot_upd` depois do apply, não o percentual acumulado. Delta 0 = D1 falhou |
| B3: HOT em contas a receber | Incremental vigente, com ~1–9 k updates/dia (só +1.428 desde a manhã de 04/11) | ⏸️ Reabrir se voltar a ≥ ~30 k/dia ([hot-contas-pagar-lote11.md](../../../historico/hot-contas-pagar-lote11.md)) |
| D5: índices com 0 scans | ~550 MB sem leitura em 4,5 d: `radar_empresas` (`idx_radar_muni_cover` 150 MB, `lista_estab` 58, `lista_novas` 43), `health_score_history` (104 + 25), `priority_score_log` (65 + 17), `tint_formulas` `idx_tint_formulas_nome_cor` 81 | Releitura em **2026-11-07 10:33 UTC**. O Radar tem uso mensal: não decidir DROP com menos de um ciclo |
| B1 (v4): expurgo semanal dos scores | 451 k linhas > 60 d ainda presentes. O cron de domingo 04:30 nasceu em 02/11 | 1ª passada em **2026-11-08** |
| Lotes de tela do v4/v5: ganho pelos web-vitals | Sem leitura de campo. O build servido (`index-7Jev-eUC`) ainda não tem linha em `telemetria_vitals`, e o Publish de #3603 não foi verificado | ~2026-11-09, separando por **build adotado**. Chegar à data não garante amostra |
| F2: TTFB | Sensor com 1 usuário (ver §1) | Reabre com amostra de mais de 1 usuário |
| Lote 9 E3: merge queue | 🚧 Bloqueado pela plataforma: repo de conta pessoal ([histórico](../../../historico/ci-merge-queue-bloqueada-repo-pessoal.md)) | — |

## 1. Como ler

- **Medido**:
  - `psql-ro` em prod, com contadores de **~4,5 d** desde o restart sujo de 2026-10-31 10:33 UTC (`pg_stat_*` zerados; `pg_stat_statements` continua ilegível pelo `claude_ro`);
  - `gh run`, 47 runs do CI depois do escopo do E1 (04/11 12:43Z → 23:58Z);
  - `telemetria_vitals`.
- **Estimado** = ganho em ms ou min; é hipótese até medir.
- Veredito final = meu, depois do Codex. ✔ = conferi no código.
- **Os sensores de uso mostram 1 usuário.**
  - `telemetria_vitals` tem 139 linhas, todas do master, de 02/11 a 04/11.
  - `telemetria_probes`, que existe desde 27/08, também tem 1 usuário só.
  - O reporter (`src/lib/analytics-vitals.ts`) não filtra papel, e a base tem 2 employees.
  - O Codex contestou a leitura: 1 usuário **não** invalida os itens F, porque o founder pode ser o usuário legítimo de uma tela administrativa. O que falta é saber **persona e tarefa**.
  - Por isso os itens F daqui valem pelo **laboratório antes/depois** (o método que funcionou no lote 6/6b), não pelo campo.
  - **Correção (C) não espera adoção** quando o comportamento errado é reproduzível numa tela **ativa** do manifesto. Tela de módulo congelado espera a retomada (ver C3 nos cortes).

## 2. Itens, um a um

### C. Correção e dinheiro honesto

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| C1 | **A4-DADO** — a próxima-melhor-ação fabrica caixa disponível | ✔ `fin-next-best-action/index.ts:152-157` aplica `?? 0` em `dias_cobertura` e `saldo_tesouraria`, e só marca confiança baixa quando a resposta inteira é nula. ✔ `:69` faz `disponivel ?? 0` de novo. ✔ A A1 devolve cobertura `null` legítima ("sem base de saída", `fin-cashflow-engine/index.ts:1195-1201`) e motivos em `confianca_dados` (`:1512-1517`), que a A4 descarta. Reprodução do Codex: cobertura `null` + saldo 10.000 → **disponível 0, confiança alta** | AJUSTAR: corrigir junto o transporte, o helper espelhado, `classificarStatus` (`:70`) e o contrato do front (`financeiroService.ts:1398`). Nem toda degradação da A1 anula o caixa: a de PMR/PMP/CCC (`:599`) não anula | **MANTER** (M) — money-path: prova + Codex; deploy de edge + Publish |
| C2 | **REC-ZERO** — os cards do Recebimento mostram zero em falha | ✔ `AdminEstoqueRecebimento.tsx:41-46,53-59,63-72,86-93`: as 4 queries descartam `error` (`count ?? 0`, `data ?? []`). ✔ A renderização fabrica de novo em `:104,111,118,125` (`?? 0`). Resultado: "Valor em trânsito R$ 0,00" e "0 divergências" mostrados como fato | AJUSTAR: os **4 cards**, não só 2. Os `formatBRL` de `reposicao/pedidos/shared.ts:29` e `grupos/format.ts:13` só entram com consumidor que recebe nulo demonstrado (os hooks de grupos já convertem antes) | **MANTER** (P) |
| C4 | **SKU-DEMANDA** — a ficha do SKU esconde falha de leitura | ✔ `SkuDetailSheet.tsx:97` `if (error) return null`, e `:117` `if (error) return []`. O gráfico recebe vazio sem aviso | AJUSTAR: falha **não** vira 90 pontos em zero (isso é o SKU sem venda, `:122-130`); vira vazio mudo (`:417`). Corrigir os estados de leitura, sem dizer que muda o motor de demanda | **MANTER** (P) |
| C5 | **DES-HIST** — o histórico do desconto por desempenho inventa meta e faturado | ✔ `useHistoricoData.ts:99-100` `Number(… ?? 0)` para o faturado. ✔ `:118` `meta_faturamento ?? live?.meta_pessoal ?? 0` **leva a meta atual para trimestre antigo** sem meta | AJUSTAR: o escopo é maior. O hook só expõe loading (`:165-181`), e o trimestre passado mostra "Meta não atingida" (`QuarterCardItem.tsx:35-42`). Corrigir nulidade, procedência temporal e julgamento visual juntos | **MANTER** (P–M) — DES é dinheiro do cliente: Codex no PR |
| C6 | **TOTAL-EDITADO** — o total do pedido de reposição volta ao antigo quando o editado é zero | ✔ `reposicao/pedidos/DetalhesModal.tsx:86` `formatBRL(totalAtual \|\| pedido.valor_total)`: zero editado (todas as quantidades zeradas) mostra o total antigo no cabeçalho, enquanto o rodapé mostra o recalculado | Achado da contestação (acréscimo do Codex) | **MANTER** (P) |

### F. Velocidade do app

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| F7 | **CR-BOOT** — `commercial_roles` relido depois do auth | O `useMyCommercialRole` relia o que o `AuthContext` já tinha lido, e o lab do 6b mediu esse REST como o serial dominante que sobrou. O `useCommercialRole.ts:78-100` (legado, `useEffect`+`useState` por instância, chamado pelo `useDisplayAccess`) faz a mesma leitura | AJUSTAR: semear pela **resposta bem-sucedida**, nunca pelo estado do contexto, preservando lente e geração do auth | ✅ **ENTREGUE pelo #3607 (v5 lote 6c)**, mergeado enquanto este plano era escrito: desktop −412 ms, mobile sem ganho (o chunk é o gargalo) ([histórico](../../../historico/boot-dashboard-paralelo-auth-lote6b.md)). O resíduo do `useCommercialRole` "não segura a home" e fica para quando tocar o hook |
| F9 | **TINT-COUNT** — a home do tintométrico conta 1 M linhas | ✔ `TintDashboard.tsx:26` `count: 'exact'` sobre `tint_formulas` (1.002.148 linhas): **215 ms quente / 7.953 ms frio** (`psql-ro`, index-only scan) | AJUSTAR: `staleTime` longo não salva a 1ª visita e congelaria a chave inteira (`:23-43`). Separar a contagem cara e, se for estimada, rotulá-la como aproximada | **MANTER** (P) |
| F8 | **DRE-IO** — 3 DRE em série no consolidado | ✔ `useFinanceiro.ts:243-245`: três `await getDRE` independentes | AJUSTAR: condicionado ao uso do DRE **consolidado**; preservar geração, ordem e falha integral | ✅ **ENTREGUE pelo #3610** (o founder confirmou que usa o consolidado). **Publish conferido no bundle servido** em 2026-11-05: o chunk `useFinanceiro-BQzhV1ju.js` faz `Promise.all(…map(getDRE))` + `.flat()` ([histórico](../../../historico/dre-consolidado-paralelo-f8-v6.md)) |
| F11 | **BOOT-ADIAR** — polls secundários competindo com o LCP | `AppShell.tsx:452-552` + `useDataHealth.ts:17-20` | AJUSTAR: a contagem de ~13 polls superestima, porque telefonia, tarefas e WhatsApp estão congelados (`AppShell.tsx:533,538,547`). Medir as requisições realmente disparadas antes de adiar | **DESCARTADO** (2026-11-05, lab A/B): o teto, que é remover TODOS os badges do shell (−10 req no boot), não move o LCP: mobile Δ −20 ms (p=0,68), desktop +4 ms (p=0,33). No mobile os polls saem em 7,0 s e o LCP pinta em 9,1 s, junto do chunk do dashboard. Adiar não ganharia nada. Achado consertado no mesmo PR: o cliente polava `fin_period_overrides` a cada 30 s, e a RLS só deixa staff ler. [histórico](../../../historico/f11-polls-boot-diagnostico-v6.md) |

### E. Dev e CI

Base nova (✔ `gh run`, 47 runs): PR verde p50 **20,1 min** (p90 28,5), contra 24,4 no v5. Com `provas-sql` dá 23,6; **sem, 8,4** (o escopo do E1 pulou 11/21). A fila p90 caiu de 17,5 para **5,2 min**, e o caminho crítico com provas é `provas-sql-uniao`. 0 flaky. Houve 1 main vermelha de 6h33 em 03/11, por **push direto "Lovable update"** fora de PR: o merge queue também não o pegaria. `gates:rapidos` local leva 5,6 s, e o lado local não é gargalo.

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| E9 | **LPT** — rebalancear as partes do núcleo SQL | Parte 5 com p50 de **21,0 min** contra 16,1–18,7 nas outras. No mesmo run (41834500673), a parte 3 teve 10,8 min de provas e a parte 5, 19,4. **8 provas** de `db/nucleo-ci.txt` sem custo em `db/nucleo-ci-custo.txt` (caem no default de 30 s) | MANTER: o próprio `nucleo-ci-custo.txt:5-17` prescreve a re-medição. Tirar a promessa de "~3 min": a média das medianas não é a duração balanceável | **MANTER** (P) — dado, não máquina ✅ **ENTREGUE pelo #3617 (lote 6)**: tabela re-medida (20 runs), LPT 16,4 min de núcleo por parte; pior parte 18,8 / 19,2 contra p50 20,2 ([histórico](../../../historico/ci-lote6-v6-lpt-remedido-e-shard-vitest.md)) |
| E10 | **SHARD** — `testes` em 2 shards do vitest | `testes` 7,3 min é o caminho crítico em 6/11 PRs sem provas (1.045 arquivos, `pool: forks`) | AJUSTAR: é experimento. Duplica setup e vaga; preservar `forks` (o `vitest.config.ts` depende de `process.chdir()`); aceitar só se a parede até `validate` cair, contando runner-min | **MANTER como experimento** (P–M) ✅ **MANTIDO pelo #3617 (lote 6)**: `testes` 7,2 → 4,4 / 4,28 min (2 attempts); crítico sem provas −0,7 a −1,0 min, +1% de runner ([histórico](../../../historico/ci-lote6-v6-lpt-remedido-e-shard-vitest.md)) |
| E13 | **V8-LOTE** — o gate de sintaxe sobe 1 Node por módulo | ✔ `scripts/edges-sintaxe-gate.ts:221-223`, pool de 4. Ensaio local do Codex: 28,9 s com `node --check` contra 146 ms de parse num processo só (a transpilação de 16 s fica igual) | AJUSTAR: o script roda em **Bun**, e parse in-process trocaria o motor que o gate (#2720) verifica. Usar 1 processo **Node** persistente, preservando diagnóstico TS, calibração e falha-fechada | **DESCARTADO** (2026-11-05, timings de 12 runs do `ci.yml`, 4 já com o shard do #3617): o step inteiro dura **5–8 s** no runner (os 28,9 s eram do Mac local). O `edges-e-build` não foi o último job antes do `validate` em nenhum run. Depois do shard, ele só disputa o caminho crítico nos ~14% de runs sem provas, e o teto ali é ≤ 8 s ([histórico](../../../historico/e13-v8-lote-descartado-v6-lote7.md)) |
| E11 | **ESCOPO-FALSIF** — escopo para os 3 `falsificacao` e o `sonda:cron-prova` | ≈21 runner-min por run, inclusive só-docs | AJUSTAR: o ganho direto é runner-min. O de fila é hipótese; o `validate` rejeita falsificação pulada (`ci.yml:1475-1497`) | ⏸️ **ADIADO** — a fila p90 caiu para 5,2 min; reabrir se voltar ao p90 do v5 |

### D. Banco e edges

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| D6 | **WATCHDOG** — o `data-health-watchdog` ficou 4× mais lento em 5 dias | ✔ `cron.job_run_details`, média/dia: **1,48 s** (30/10) → 1,65 → 3,18 → 4,71 → 4,59 → **5,67 s** (04/11), 48 runs/dia. O EXISTS de `sales_orders` (lote 9 do v4) está corrigido; a curva é de outro check. `fin_sync_log`: 5.289 seq scans × 23.919 tuplas em 4,5 d | AJUSTAR a hipótese: `fin_sync_watchdog_check` é outro caminho, fora do trio acoplado. O `EXPLAIN` da chamada externa esconde o custo interno, e o `EXPLAIN ANALYZE` do watchdog **executa os efeitos** dele. Recortar as leituras internas, read-only | **DIAGNOSTICADO** (2026-11-05, só leitura, duas sessões): o lento é o job 101 (1,39 → 6,43 s). O `fin_sync_watchdog_check` está estável, o que refuta a premissa. O corpo do compute custa ~0,23 s quente, mas o watchdog no cron lê ~1.123 blocos do disco por chamada (`pg_stat_statements`), a duração é bimodal e jobs sem relação ficaram 2–5× mais lentos desde 01/11. Hipótese aberta: cache/IO da instância (6,9 GB contra 256 MB de `shared_buffers`). Não vale PR de código; fechar exige o painel de IO do founder ([histórico](../../../historico/d6-watchdog-diagnostico-v6.md)) |
| D8 | **ROLLBACK** — 17 % das transações terminam em rollback | `pg_stat_database`: `xact_rollback` 227.464 de 1,31 M desde 31/10; à noite, 0,9 % | AJUSTAR: não é taxa de falha do produto. O `pg_stat_statements` só registra statements bem-sucedidos e o PostgREST faz rollback de propósito. Cruzar deltas por janela, logs com SQLSTATE e papel | **DIAGNÓSTICO** (P) — logs pelo founder |
| D9 | **ESTATÍSTICA VELHA** — `venda_sugestao` estimada em 75× o real | `venda_sugestao`: 103 MB, 2.993 linhas, `reltuples` 223 k. `radar_empresas` (1,3 GB) sem vacuum/analyze desde o restart | AJUSTAR: separar as tabelas. `venda_sugestao` tem evidência forte. No Radar, tamanho e falta de manutenção na janela não provam bloat. VACUUM comum não devolve GB ao disco | **DESCARTADO** (2026-11-05, psql-ro): `count(*)` = **231.536**, então o `reltuples` de 223 k está certo. O 2.993 era o `n_live_tup`, contador zerado no restart de 31/10 — não o tamanho da tabela. Radar = só verificar |

## 3. Cortes

| # | Item | Por quê |
|---|---|---|
| C3 | Fila de contato: ticket nulo vira 0 e exclui o cliente | O defeito é real e mais forte do que parecia: o cliente é **excluído** por `valor_nao_paga` antes da ordenação (`contact-list.ts:80,95-99`). Mas `/rota` está **congelada até 2027-01-10** (✔ `manifesto.ts:781-787`). Reabrir na retomada do módulo, sem inventar ticket substituto |
| D7 | Scores gravados 2×/dia no histórico | Premissa falsa. A 2ª passada (06:25, #1603) grava 2×/dia **por desenho** (✔ `20260730120001_calculate_scores_reforco_0625.sql:23-33`: idempotente, adensa a série; "a saída é retenção, NÃO remover o segundo disparo"). 13.266/dia era 2 × 6.633: os 33.986 de hoje são a população maior. A retenção de 60 d já existe (B1) |
| F10 | Radar: 3 RTT em cadeia antes da lista | Rodada e lote começam em paralelo (`useRadarLista.ts:116-129`); a lista espera o lote por correção (`:132-141`); os irmãos não bloqueiam a lista (`useRadarIrmaos.ts:13-15`). Fica como hipótese |
| NF-NULL | Consolidação de itens de NF somando `valor_total` nulo como 0 (`omie-sync-vendas-items/index.ts:529-531`) | 0 nulos em 3.803 linhas OBEN/180 d (`psql-ro`). Não prova impossibilidade nas outras empresas; reabrir se aparecer nulo |
| NF-CHAVES | Chaves de NF lidas sem paginação (`:316-329`) | O cron chama com `dias=3` (`omie-cron-diario/index.ts:169`), uns 60–140 itens, longe da capa de 1.000. Dívida já registrada na baseline do `single-shot-truncado-gate.test.ts:106`; reabrir se backfill manual passar de ~45 d |
| E12 | `ordem-entre-edges` com `paths:` | Quebra a invariante do próprio workflow (`ordem-entre-edges.yml:12`: check exigido de workflow filtrado nunca reporta, e o PR trava) |
| D4-res | Os 24 `has_role` meio embrulhados, o InitPlan de `cap_carteira_ler` e a busca pontual da carteira | Medidos como ruído: tráfego relevante só em `pcp_malha_staging`; ≤ 4,5 min de CPU/dia no InitPlan; ~60 s/dia na busca. "Quando tocar a tabela" |
| — | `useAdminOrderDetail` (preço 0 enviado ao Omie) | `orders` tem 0 linhas e `/orders` é módulo congelado (`manifesto.ts:17-25`): candidato a remoção, não a conserto |
| — | ESLint para `?? 0` em dinheiro | O v5 já decidiu sem ESLint novo; o padrão textual não distingue soma vazia legítima de ausência |

Os cortes do v5 (E6, D2, E2, E8, F6, E4) continuam valendo; nenhum fato novo os reabre.

## 4. Roadmap em lotes

| Lote | Conteúdo | Depende de | Quem aplica |
|---|---|---|---|
| 1 | C1 — A4 sem caixa fabricado, degradação da A1 propagada | — | sessão + prova + Codex + **deploy de edge** + **Publish** |
| 2 | C2 + C4 — estados de erro no Recebimento e na ficha do SKU | — | sessão + **Publish** |
| 3 | C5 — histórico do DES sem meta transportada nem faturado inventado | — | sessão + Codex + **Publish** |
| 4 | C6 — total editado zero respeitado | — | sessão + **Publish** |
| 5 | F9 — contagem cara do tintométrico separada | lab antes/depois | sessão + **Publish** |
| 6 | E9 + E10 — custos do núcleo re-medidos e experimento de 2 shards | — | sessão |
| 7 | ~~E13 — gate de sintaxe com 1 Node persistente~~ descartado: o step dura 5–8 s no runner e não está no caminho crítico do `validate` (ver §2 E) | — | — |
| 8 | ~~D9 — `ANALYZE venda_sugestao`~~ descartado: a premissa leu o `n_live_tup` pós-restart como tamanho real (ver §2 D) | — | — |
| — | D6, D8, F11 | §2 | diagnóstico, sem PR de código |
| — | ~~F8~~ ✅ #3610, Publish no ar (conferido no bundle servido) | founder confirmou o uso do consolidado | — |
| — | E11 | fila de volta ao p90 do v5 | ⏸️ |

Os lotes 1–7 são independentes entre si (arquivos distintos). Antes de cada um, procurar o artefato na main (`git grep <símbolo> origin/main`): o F7 foi entregue por outra sessão no meio da escrita deste plano.
