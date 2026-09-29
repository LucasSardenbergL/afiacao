# O dia da sessão lido nu: 7 funções, as skills e o gate (classe ii do fuso da sessão)

**2026-09-28/29.** Dois PRs da mesma classe. **PR-A** (branch `fix/hoje-sp-skills-gate-classe-ii`): as
consultas das skills e o gate `scripts/relogio-nu-da-sessao-gate.ts`. **PR-B** (branch
`fix/current-date-sessao-utc-funcoes-skills`, DRAFT até o Codex): a migration
`20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql`, a fixture
`db/fixtures/hoje-sp-sete-funcoes-predecessoras-prod-20260929.sql` e a prova
`db/test-hoje-sp-sete-funcoes.sh`. Segue a classe (i) de
[relogio-da-sessao-truncado-rpcs-e-views-des.md](relogio-da-sessao-truncado-rpcs-e-views-des.md) — lá o
relógio da sessão TRUNCADO por `date_trunc`; aqui, lido NU.

## Passo 0 — instância única ou classe?

Classe. A prod roda sessões em `TimeZone=UTC` (arquivo de configuração; 0 linhas de `TimeZone` em
`pg_db_role_setting` — remedido via psql-ro em 2026-09-28), e o psql-ro das skills também. A assinatura:
o dia da sessão (`current_date`, `localtimestamp`, `now()::date` e irmãos, `CAST`/`date()`/`to_char`/
`extract` de calendário sobre o relógio) e o instante que vira data na sessão (`col_at::date`,
`max(col_at)::date`, `date(col_at)`, `date_trunc` de 2 argumentos, `extract`, `to_char`). Das 21:00 às
23:59 BRT o dia da sessão já é o seguinte ao de São Paulo.

## A varredura — todos os universos, inclusive os limpos

A prod primeiro (é a autoridade: o repo diverge dela), por regex sobre `prosrc`/`pg_get_viewdef`/
`pg_get_expr`, com o trecho de cada casamento julgado à mão e os chamadores/horários/leitores
levantados por dois subagentes read-only.

| Universo | Denominador | Casamentos | Veredito |
|---|---|---|---|
| Prod: funções (fora de extensão) | 398 | 26 sem menção a SP (+1 com SP) | 9 **afetadas** · 4 UTC-consistentes · 12 latentes · 1 falso-positivo |
| Prod: views | 83 | 20 (+1 com SP) | **fase 2** (chip) — a com SP é falso-positivo (`suspensa_em` é `date`) |
| Prod: matviews | 5 | 2 | fase 2 |
| Prod: DEFAULTs de coluna | 1.439 | 10 | fase 2 |
| Prod: CHECK / policies / crons | 362 / 711 / 99 | 0 | — |
| Repo: corpos vivos de função | 312 | 17 (16 sem SP — idêntico à medição de 27/09 —, 1 com SP) | baseline do gate, com veredito |
| Repo: migrations, texto | 742 | 293 (definições que valeram um dia) | só o corpo VIVO conta; a partir do corte, o texto inteiro |
| Repo: skills (`.sql` + cercas) | 46 arquivos / 2.303 linhas | 53 sítios em 10 arquivos (+3 prosas que ensinavam a forma) | todos consertados |

9 das 26 funções que casaram viviam SÓ na prod (sem CREATE no repo) — nenhum gate textual as veria.

### As 26 funções, sítio a sítio

- **Afetadas (9).** Nesta classe: `fin_period_lock_trigger`, `get_regua_preco`, `listar_pedidos_a_separar`,
  `radar_atribuir_tarefa`, `sincronizar_ativo_omie_para_reposicao`, `trg_campanha_gera_alerta`,
  `vendas_sync_semear_janela` (PR-B). `melhoria_clientes_por_produto`: a sessão do escape de curinga do
  LIKE recria a função no mesmo voo (20260929000234) — o `wt:preflight` deu 🔴; combinamos que ELA leva as
  3 trocas de fuso e eu a tirei da minha leva. `converter_sugestao_em_campanha_flat` — o 1º material do
  briefing — está **quebrada na prod por outro defeito**: o INSERT em `promocao_item` usa
  `sku_descricao_extraido`, `desconto_base_perc`, `mapeamento_confianca` e `mapeamento_origem`, que a
  tabela não tem (pg_attribute) → 42703 a qualquer hora; **0 conversões em 325 sugestões**. Consertar só o
  relógio de uma RPC que nunca funcionou exigiria stub INFIEL à prod: foi para um reparo próprio (chip),
  com as trocas de fuso no briefing.
- **UTC-consistentes (4 + `_data_health_compute`).** `atualizar_parametros_numericos_skus` e
  `reposicao_pos_candidatos` comparam com `pedido_compra_sugerido.data_ciclo`, que a edge
  gerar-pedidos-diario grava em UTC; `reposicao_param_fila_sensor`/`_limbo_watchdog` releem o próprio
  carimbo. Trocar só um lado criaria a divergência.
- **Latentes (12).** Só-cron fora da janela (`detectar_outliers_empresa`/`detectar_skus_sem_grupo` 04:30
  BRT, `atualizar_estados_eventos_comerciais` 08:00, `limpar_sugestoes_antigas` 03:00 do dia 1); órfãs
  (`simular_formula_estoque`, `sugerir_negociacao_paralela_hoje`); carimbos SEM LEITOR
  (`sku_substituicao.data_substituicao` via `consolidar_demanda_sku`/`registrar_substituicao_sku`,
  `sku_parametros.data_ultima_mudanca_classe` via `atualizar_classificacao_skus`,
  `fin_audit_log.period_ref`, `analytics_outbox_perda.dia`); default nunca exercido
  (`simular_puxar_volume_trimestre`: o front sempre passa o trimestre).
- **Falso-positivo (1).** `prime_assinatura_update_guard`: `suspensa_em` é `date`.
- **INDETERMINADO medido.** O fallback `created_at::date` do picking/melhoria: 2 dos 1.487 pedidos de 90
  dias não têm `order_date_kpi`, 1 deles criado depois das 21h BRT — raro, mas real (entrou).

## O defeito, objeto a objeto (PR-B)

- **`fin_period_lock_trigger`** (money-path): para `fin_categoria_dre_mapping` o alvo é o hoje — no último
  dia de um mês já fechado, das 21h às 24h BRT, a trava LIBERAVA o UPDATE/DELETE que em SP é
  PERIOD_LOCKED. Falha ABERTA de uma trava contábil — hoje LATENTE: `fin_fechamentos` está vazia na
  prod (0 linhas, psql-ro 2026-09-29), nenhum mês foi fechado e a trava ainda não trava nada; o defeito
  passa a valer no primeiro fechamento. Por isso esperar o Codex não custa nada aqui.
- **`radar_atribuir_tarefa`**: a tarefa de retomada vencia D+8 em vez de D+7 (a `v_tarefas_estado` julga
  atraso pelo hoje de SP).
- **`vendas_sync_semear_janela`**: a guarda anti-futuro aceitava `date_to` = amanhã de SP.
- **`trg_campanha_gera_alerta`**: a campanha cancelada no seu último dia, de noite, não gerava o alerta
  `promocao_suspensa`.
- **`sincronizar_ativo_omie_para_reposicao`**: `eventos_outlier.data_evento` nascia amanhã no sync manual
  noturno de produtos (e é comparada com `data_emissao` no drill-down).
- **`listar_pedidos_a_separar`**: o pedido nativo do app das 21h–24h BRT aparecia com a data de amanhã; a
  janela de 60 dias perdia o dia mais antigo (e deixava entrar o pedido das 22h de D−61).
- **`get_regua_preco`**: a janela de 180 dias do histórico do cliente e dos comparáveis perdia o dia mais
  antigo.

## As skills (PR-A)

A borda segue o TIPO da coluna: DATA de SP (`(now() at time zone 'America/Sao_Paulo')::date`, num CTE `h`
quando repete) contra `date`; INSTANTE da meia-noite de SP contra `timestamptz` (`sales_orders.created_at`,
pela aritmética no relógio de parede, como a #15); o instante que vira data,
`(created_at at time zone 'America/Sao_Paulo')::date`. As 4 horas do diagnóstico de sync eram UTC DE
PROPÓSITO (a skill compara com o `schedule` do pg_cron): passaram a escrever `AT TIME ZONE 'UTC'` e a
rotular `*_utc`, em vez de abrir exceção no gate. Evidência: cada consulta editada rodou na prod
(read-only, 00:04 BRT de 29/09) nas duas versões — nas colunas `date` o resultado novo é IDÊNTICO ao
antigo fora da janela; 2 cercas falham nas DUAS versões por outro motivo (`omie_clientes` não existe na
prod — defeito pré-existente da skill). A prova do caixa (`db/test-cfo-caixa-90d-otica.sh`) executa o
bloco (c) e semeava por `CURRENT_DATE`: passou a semear pelo mesmo hoje de SP (senão ficaria vermelha no
CI entre 00:00 e 03:00 UTC).

## O gate — `scripts/relogio-nu-da-sessao-gate.ts`

A pergunta do briefing: estender algum gate à classe (ii), dado 44% de falso-positivo nos corpos sem SP?
A resposta foi separar os universos pelo que o número diz de cada um:

| Universo | Medido | Decisão |
|---|---|---|
| skills (`.sql` + TODA cerca de `.md`) | 53 sítios, falso-positivo ~0 (o único "UTC de propósito" virou UTC escrito) | limpas, sem baseline |
| migrations a partir do corte `20260927195430` (texto inteiro: função, view, DEFAULT, cron, `DO`) | as 2 da cauda limpa de 27/09 (+ a do PR-B) | limpas, sem baseline: o fuso pedido é o EXPLÍCITO — UTC de propósito se escreve `(now() AT TIME ZONE 'UTC')::date` |
| corpos VIVOS de função | 19 sítios em 17 corpos (44% UTC-consistentes) | baseline COM VEREDITO e motivo por sítio; só encolhe (novo reprova, quitado reprova, a contagem é parte da identidade) |

O falso-positivo de 44% era de um gate que CONDENASSE os corpos antigos; um gate que exige o fuso escrito
só no código NOVO não tem falso-positivo — tem o custo de escrever `AT TIME ZONE 'UTC'`. O builder do
Lovable, que escreveria `CURRENT_DATE` sem saber, não gera migration aqui desde junho (0 UUID de 06 a
09/2026).

Pisos por universo (migrations 700, corte 2, arquivos de skill 40, linhas de código 2.000, corpos vivos
290), cada um derrubado SOZINHO por um teste; `scripts/mutcheck.d/relogio-nu-da-sessao.mut`: 22 mutações,
uma por camada. Limites declarados no próprio gate: o que só existe na prod, SQL em string, timestamptz
fora de `*_at`/`*_em`, e literal que CITA a forma errada (numa POS, escreva a agulha partida).

## A prova (PR-B) — 41 asserts, 18 sabotagens

`db/test-hoje-sp-sete-funcoes.sh`, no contrato do irmão `db/test-hoje-sp-sessao-utc-precos-piso.sh`:

- Relógio controlado (`test.agora`, tripwire Z9T01; só as 7 funções têm `pg_catalog` depois de `public`).
  D = 28/02/2025 — último dia de um mês que a trava tem FECHADO —, 4 instantes (20:59:59 · 21:00:00 ·
  23:59:59 BRT de D · 00:00:00 de D+1) sob sessão UTC e SP; B0 prova que as duas sessões são mundos
  diferentes.
- H1: os 7 predecessores da fixture têm o md5 exato da prod; H2: onde há CREATE no repo, a fixture é a
  última definição módulo comentário (5/5 — a deriva de 2 corpos era só `--`).
- X: deriva numa RPC e num gatilho aborta a PRE; as 7 AUSENTES nascem com o fecho PORTA_GATE nas 4 RPCs,
  sem e com o default ACL do Supabase; re-aplicar é seguro. D1: cada corpo instalado, com a troca
  desfeita, tem o md5 exato do predecessor (a troca é a ÚNICA diferença).
- R0: sem `test.agora`, cada função bate no tripwire — é o que pega o `current_date` LITERAL, que o
  relógio controlado não intercepta; no radar o dedupe já lê `now()`, e quem pega o literal lá é o bloco
  B. A1: anon barrado pelo ACL nas 4 RPCs. W: as 7 com o `search_path` de prod restaurado (o semeador
  com `''`) executam no relógio real.
- Matriz: servidor UTC/SP × `lc_messages` C/pt_BR — 41/41 nas 4; `--falsificar` 4/4 × (controle verde
  + 18/18 vermelhas no assert certo).

O que a falsificação ensinou (e por isso ela existe): (1) com o ACL reaberto a anon, o A1 caía no gate do
corpo e virava ERRO de execução — vermelho que não mata mutante; passou a ler ACL × GATE pela mensagem
exata, e o vermelho é por RESULTADO. (2) Sob carga, 3 execuções do X1 saíram "falhou, mas não pela PRE"
com a mensagem certa na saída; o teste era `printf "$out" | grep -q` sob `pipefail`. Trocado por
casamento nativo do bash, a matriz seguinte (mesma carga) não repetiu. A hipótese — pipe de 512 bytes
sob pressão de memória, `grep -q` saindo cedo, SIGPIPE virando "falso" — foi medida numa máquina ociosa
e NÃO reproduziu (0/900): fica como suspeita, com dono (chip "Trocar printf | grep -q sob pipefail nas
provas de db/": 22 sítios em 8 provas).

No CI, a prova passou de primeira no runner Linux (41 asserts em 3 s; `--falsificar` 18/18 em 52 s) —
e foi ela que estourou o teto do job `provas-sql`: o passo do núcleo sozinho foi a 11 min 35 s, e o job
foi CANCELADO no teto de 12 min com `SQL_PROOF_OK 46/46` já impresso (a main levava 8,5–10 min). O teto
subiu para 20, com a medição no comentário do `ci.yml` — o cancelamento no teto não diz qual prova
custou, então ele tem de ficar acima do custo.

## O ensaio na PROD

`bun run db:aplicar supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql --ensaio`
(sha256 `803ee5ca…`): rodou INTEIRA contra o estado real — trava, PRE batendo o md5 exato dos 7 corpos
vivos, os 7 `CREATE OR REPLACE`, o fecho e a POS (`NOTICE: POS OK: 7 funções…`) — e fez ROLLBACK. A 2ª
testemunha (psql-ro, outra conexão) mostrou o radar ainda com o md5 do predecessor: nada gravado.

## Codex

Consultado em 2026-09-29 00:4x: **exit 79** — cota em 86% (teto de 85%), janela reabre 03/10 19:11; o
wrapper não gastou a chamada. Money-path (trava contábil e régua) → o PR-B fica **DRAFT** até o Codex;
a prova PG17 falsificável é o Caminho B já pronto. O PR-A (skills + gate) não é money-path.

## Fora, com dono

- **Fase 2 — views, matviews e DEFAULTs** (chip "Consertar o dia da sessão UTC em views, matviews e
  defaults"): inclui o aging ao vivo, a campanha "ativa hoje" e o cron `15 */2` UTC do omie-cron-diario,
  que roda 21:15 e 23:15 BRT e GRAVA parâmetros de compra lidos de views com `CURRENT_DATE`.
- **`converter_sugestao_em_campanha_flat`** (chip "Consertar converter_sugestao_em_campanha_flat
  quebrada na prod").
- **`melhoria_clientes_por_produto`**: com a 20260929000234 (sessão do LIKE); quando entrar, o gate pede
  para tirar a linha da baseline (QUITADO).
- **Classe irmã no TypeScript**: `new Date().toISOString().slice(0,10)` como "hoje" (edge
  gerar-pedidos-diario, dialogs de reposição, `useRoutePlanner`) — anotada no chip da fase 2.
