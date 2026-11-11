# Score de visita: quem nunca comprou fica abaixo de quem compra (plano v8, lote 7 — D13, opção c)

**Data:** 2026-11-11 · **Diagnóstico:** [`visita-fila-represada-d13-v8.md`](visita-fila-represada-d13-v8.md) ·
**Decisão do founder (11/11):** um cliente que está na carteira do Omie e nunca fez pedido deve ficar **abaixo** de um
cliente ativo nas sugestões de visita. Isso fecha a opção (c). A (a), aumentar a vazão do drain, e a (b), parar de
enfileirar o `omie_import`, foram descartadas no diagnóstico e ficaram de fora.

## O que mudou

A regra vive na edge `visit-score-recalc-client` (é ela que grava `customer_visit_scores`), com espelho em
`src/lib/visit-scoring/missions.ts`. Não há função SQL de score: o `pg_get_functiondef` da prod só tem os dois gatilhos
de enfileiramento (`enqueue_visit_score_recalc_from_client_score`, `..._from_visit`), que não mudam.

1. **A data do import não conta como cadastro recente.** O +20 de "novo" só vale para `prospect_source` diferente de
   `omie_import` (`cadastroRecente`), e só no caminho do lead declarado.
2. **Quem nunca comprou e não é lead declarado sai com 10.** `nuncaComprou` = nenhum pedido de venda **e**
   `sales_history_status` fora de `ativo`/`stale` (status nulo não prova compra). Para esse cliente: prospecção 10
   (`SCORE_CARTEIRA_SEM_PEDIDO`), recuperação 0, relacionamento 0. O lead declarado (`is_prospect`) segue com base 70.
3. **As linhas que já existem foram corrigidas por backfill**, sem esperar o drain de 500/dia
   (`db/2026-11-11-visita-carteira-sem-pedido-backfill.sql`).

O bloco das três peças (`MIRROR-START carteira-sem-pedido`) é idêntico na edge e em `src/`, com paridade no
`edge-money-path-invariants.test.ts`. VERSAO da edge: `v1.1-carteira-sem-pedido`.

## Por que mexer também na recuperação

Baixar só a prospecção não resolvia. Todo `sem_historico` tem `churn_risk` 100 e `health_score` 0 (15.757 de 15.757 em
`farmer_client_scores`), e a recuperação é `churn_risk × 0,5` = **50** nas 9.665 linhas de quem nunca comprou. Isso fica
acima da mediana dos compradores ativos (31,7). Recuperação e relacionamento pedem histórico de compra; para quem nunca
comprou, o valor medido é 0. É a mesma linha da guarda da spec de `sales_history_status` (2026-06-21): o
`sem_historico` não ocupa vaga de recuperação.

## Por que 10 (medido por `psql-ro`, 11/11)

| quem compra (linha em `customer_visit_scores`) | n | mín. | p5 | p25 | mediana | ≤ 30 |
|---|---:|---:|---:|---:|---:|---:|
| `ativo` | 387 | 19,97 | 23,2 | 27,0 | 31,7 | 161 (42%) |
| `stale` | 850 | 26,0 | 30,2 | 49,0 | 50,0 | 43 |
| todos | 1.237 | 19,97 | 25,1 | 33,7 | 49,5 | 204 |

- 42% dos ativos ficam em 30 ou menos. Qualquer valor que deixasse o nunca comprou acima do corte `visit_score > 30`
  do card passaria na frente deles. Por isso o piso tem de ficar abaixo de 20, e o cliente que nunca comprou sai da
  lista de cidades do card. Isso é consequência da decisão, não uma escolha à parte: as cidades da lista passam a ser
  as que têm comprador acima de 30, e dentro da cidade ele ainda preenche as vagas que sobram, abaixo dos compradores.
- `churn_risk = 100 − health_score` vale em 17.002 de 17.002 linhas. Com esse acoplamento, o menor score possível de
  quem compra é ~13 (recuperação e relacionamento se cruzam em health ~54, com a penalidade de recência máxima e visita
  no próprio dia). 10 fica abaixo do mínimo medido e do teórico. O teste `o comprador de menor score possível fica acima
  do piso` varre health de 0 a 100 nesse pior caso.
- 10 é maior que 0, o valor de quem não é candidato.
- O sinal de classe ativada não sobe o cliente de carteira (hoje as 3 classes estão desligadas). O +10 de sinal
  continua valendo no caminho do lead.

Dois casos de borda, ambos com contagem medida: o cliente com histórico `ativo` e sem pedido no app (1 linha) deixa de
ser prospecção (saía com 90) e passa pela regra de comprador; o perfil sem origem e sem pedido (4 perfis na prod) cai
no piso como qualquer cliente que nunca comprou.

## Top 30 das sugestões: antes e depois simulado

Mesma lógica do card (`useMyVisitSuggestions`): cidades com `visit_score > 30` por dono; cidade padrão = maior
`top_score`; top 30 da cidade por `visit_score` desc. "Simulado" aplica a regra nova (nunca comprou e não lead → 10)
sobre as linhas atuais. Consulta: `db/validar-visita-top30-d13.sql` (`-v simular=0` = hoje, `-v simular=1` = regra nova).

| dono | cidades na lista | compradores no top 30 (todas as cidades) | cidade padrão | compradores no top 30 da cidade padrão |
|---|---|---|---|---|
| Tatyana — antes | 138 | 43 de 1.725 | Belo Horizonte | **0 de 30** |
| Tatyana — depois (simulado) | 40 | 339 de 852 | Divinópolis | **30 de 30** |
| Lucas — antes | 164 | 58 de 1.523 | Carmo do Cajuru | 1 de 30 |
| Lucas — depois (simulado) | 53 | 198 de 871 | Carmo do Cajuru | 15 de 30 (a cidade só tem 15 compradores) |
| Regina — antes | 55 | 105 de 561 | Balsas | 2 de 3 |
| Regina — depois (simulado) | 40 | 305 de 493 | Balsas | 2 de 3 |

Nas vagas que sobram depois dos compradores, quem nunca comprou entra em ordem, abaixo de todos eles. O depois MEDIDO
(após deploy e backfill) está em "No ar", abaixo: bate com o simulado em todas as colunas.

## Backfill

Alvo, conservador: nenhuma linha em `sales_orders` (de status nenhum, apagada ou não), `sales_history_status` fora de
`ativo`/`stale`, `is_prospect` não verdadeiro, expansão sem insumo, fora de `excluir_da_carteira`. Pré-voo em 11/11:
**9.664 linhas**, nenhuma com `sales_orders` de qualquer tipo, nenhuma excluída da carteira, nenhuma com expansão.

- **TRAVA:** a última atestação da edge em `deploy_atestacoes` tem de ser a v1.1. Com a edge velha no ar, o drain das
  07:00 regravaria 90 em quem está na fila.
- **PÓS:** nenhuma linha do alvo com o score velho; e, por outro caminho, nenhuma linha marcada pelo backfill é de
  quem compra ou de lead.
- `calculated_at` fica (não é recálculo da edge); o `score_breakdown` ganha `backfill.regra = d13-carteira-sem-pedido`,
  que some no próximo recálculo da edge.
- Prova PG17: `db/test-visita-carteira-sem-pedido.sh`, 21 asserts verdes em `LC_ALL=C` e em `pt_BR.UTF-8`, com 6
  sabotagens inline (filtro de lead, de pedido, de excluído, de expansão, score errado e TRAVA) e controle verde antes e
  depois.

A fila (6.577 pendentes, 6.131 sem linha) segue no drain de 500/dia, sem mudança. Cada um entra com 10, no fim da cidade,
e o diagnóstico já mostrava que o ritmo normal (4 a 150 por dia) cabe no lote.

## Ordem de deploy

merge → deploy da edge pelo MCP do Lovable → sonda (atesta a v1.1 no ledger) → `bun run db:aplicar` do backfill (a TRAVA
recusa antes da atestação) → 2ª testemunha por `psql-ro` → top 30 depois, medido. Sem Publish: o front não muda
(`src/lib/visit-scoring/missions.ts` só é importado por testes; o card só lê a tabela).

## Uso

`route_visits` e `farmer_calls` estão vazias desde sempre. O ganho é dado honesto na tela, não adoção medida. Nenhum
sensor novo.

## Como refazer

`~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1`: distribuição de `visit_score` por `sales_history_status` e por pedido
(`score_breakdown->'inputs'->>'sales_orders_count'`), `churn_risk` vs `100 − health_score` por status, scores de missão
de quem nunca comprou, alvo do backfill (as cláusulas do UPDATE como `count(*)`), e o top 30 por dono/cidade com a
regra nova aplicada como `CASE` sobre a linha atual (`db/validar-visita-top30-d13.sql`).

## No ar (11/11)

- **Código:** #3827, mergeado às 15:09 UTC (`82fdcf511`). O PÓS do backfill usa `IS DISTINCT FROM 0`, não `<> 0`
  (catraca `assert-verde-por-ausencia` em `.sql` novo).
- **Edge:** `visit-score-recalc-client` `v1.1-carteira-sem-pedido`, vista pela sonda às 17:11 UTC na janela viva e copiada
  para `deploy_atestacoes` pelo coletor (`deploy-atestacoes-colher`, a cada 15 min) logo depois. A TRAVA lê só o
  ledger, então o backfill esperou essa cópia.
- **Backfill:** `bun run db:aplicar` (ensaio e depois de verdade, commit `3064c8969`, sha256 `b3f834bb711a…`), recibo
  **#1089** em `db_aplicacoes`. `D13_BACKFILL_OK marcadas=9664`, igual ao pré-voo.
- **2ª testemunha (`psql-ro`):** 9.664 linhas com `backfill.regra = d13-carteira-sem-pedido`, todas com `visit_score` 10
  e missão `prospeccao`; 0 linhas restantes no alvo; 0 linhas marcadas de comprador ou lead.
- **Top 30 depois, medido** (`db/validar-visita-top30-d13.sql -v simular=0`):

| dono | cidades na lista | compradores no top 30 (todas as cidades) | cidade padrão | compradores no top 30 da cidade padrão |
|---|---|---|---|---|
| Tatyana | 40 | 339 de 852 | Divinópolis | **30 de 30** |
| Lucas | 53 | 198 de 871 | Carmo do Cajuru | 15 de 30 |
| Regina | 40 | 305 de 493 | Balsas | 2 de 3 |

A fila de recálculo (6.577 pendentes) segue no drain de 500/dia, agora com a regra da v1.1. Sem Publish: o front não mudou.
