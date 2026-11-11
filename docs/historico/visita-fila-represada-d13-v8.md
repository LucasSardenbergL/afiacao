# Fila do score de visita represada: o gargalo não é o lote de 500 (plano v8, lote 7 — D13)

**Data:** 2026-11-11 · **Plano:** `docs/superpowers/plans/2026-11-10-plano-melhoria-v8/README.md` §2 C, D13 ·
**Tipo:** só diagnóstico (psql-ro + leitura de código). Nada implementado; **a decisão de produto é do founder**.

## A pergunta

`visit_score_recalc_queue` tinha 7.070 pendentes desde 02/11 06:00, 7.069 de perfis `omie_import`. O job 60
(`0 7 * * *`) drena 500 por dia. A pergunta do plano: **(a)** cliente importado precisa de score de visita e o lote de
500 é o gargalo, ou **(b)** não precisa e o enfileiramento está errado.

**Resposta curta: nenhuma das duas, como está escrita.** O enfileiramento faz o que foi desenhado para fazer. O lote de
500 só atrasa. O que está errado é o **score que esses clientes recebem**: o importado que nunca fez pedido ganha 90,
acima de quem compra (mediana 70), e já ocupa as 30 primeiras posições da cidade padrão das duas farmers com carteira
grande. Drenar mais rápido piora a tela.

## Quem enfileira e por quê

- Gatilho `trg_farmer_client_scores_enqueue_visit_recalc`, `AFTER UPDATE ON farmer_client_scores`, função
  `enqueue_visit_score_recalc_from_client_score` (lida da prod): enfileira `reason = 'score_changed'` quando mudam
  `priority_score`, `churn_risk`, `expansion_score` ou `signal_modifiers` e a linha tem `customer_user_id` e
  `farmer_id`. Um pendente por cliente (`ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING`).
- Outro gatilho, em `route_visits`, enfileira por visita (essa tabela está vazia, ver abaixo).
- O recálculo de `farmer_client_scores` é o job 36 `daily-calculate-scores` (`0 6 * * *`), com reforço às 06:25 (job 169). Todo enfileiramento dos
  últimos 15 dias caiu na hora 06.
- **O que aconteceu em 02/11:** os 10.406 perfis criados pelo import de 01/11 ganharam a linha de `farmer_client_scores`
  por INSERT (o gatilho é só de UPDATE, então nada foi enfileirado em 01/11). No recálculo de 02/11 06:00 a linha
  mudou pela primeira vez, e 10.441 clientes entraram na fila de uma vez. Antes e depois, o ritmo normal é de 4 a 150
  por dia.
- **Todo cliente enfileirado é `omie_import`, inclusive antes de 01/11** (24 a 49 por dia de 25/10 a 01/11). Não é um
  grupo à parte: o backfill do C7 (`aprov-fantasma-origem-placeholder-c7-v7.md`) marcou como `omie_import` todo perfil
  nascido de placeholder do Omie, desde março. Na prod há 16.081 perfis `omie_import` e 4 sem origem. **Cliente
  importado é a carteira inteira.** Tirar `omie_import` do enfileiramento desligaria o score de visita de todo mundo.

- **Sem login não quer dizer fora da carteira.** O perfil placeholder nunca loga, mas é cliente real do Omie com dono:
  6.546 dos 6.577 pendentes têm dono elegível em `carteira_assignments`, e 6.576 têm cidade.

Portanto a opção (b) como escrita está errada: o enfileiramento não erra o público.

## Quem drena

Edge `visit-score-recalc-batch` (job 60, 07:00 UTC, `timeout_milliseconds = 55000`) chama
`visit-score-recalc-client` com `{ drain_queue: true, max_drain: 500 }`. A view `visit_score_recalc_pending` ordena por
`enqueued_at`: **a fila é FIFO estrita.** O mesmo batch ainda faz o "decay" dos clientes com ligação ou visita nos
últimos 30 dias, mas esse ramo não acha ninguém (ver "uso").

**`processed_at` não quer dizer sucesso.** O drain grava `processed_at` em todo item, inclusive no erro ("Always mark
processed (even on uncaught error) — avoids poison-pill", `supabase/functions/visit-score-recalc-client/index.ts:553`<!--cita: Always mark processed-->), junto com
`error: r.error ?? null`. Há ainda um terceiro desfecho: o cliente marcado `excluir_da_carteira` volta `{ ok: true }`
sem gravar score (`supabase/functions/visit-score-recalc-client/index.ts:369`<!--cita: if (flagRes.data) return { ok: true };-->). Separando os três (sucesso = `error` nulo **e** `customer_visit_scores.calculated_at`
até 10 min antes do `processed_at`):

| dia (28/10 a 11/11) | processados | com erro | sucesso com score gravado | `ok` sem score gravado |
|---|---:|---:|---:|---:|
| cada dia | 500 | **0** | 497 a 500 | 0 a 3 |
| soma dos 15 dias | 7.500 | **0** | 7.483 | 17 |

Não há nenhum `error` não nulo na fila desde sempre. Os 1 a 3 por dia sem score gravado são o retorno da exclusão da
carteira. Por isso `customer_visit_scores` recebe ~498 linhas por dia, e não 500. A vazão útil é ~498 por dia. Fila hoje
(11/11, depois do drain das 07:00): **6.577**. Nesse ritmo, esvazia por volta de 25/11.

## Quem lê o score de visita, e se o importado aparece

Nas duas telas, **`customer_visit_scores` é a FONTE da lista**: cliente sem linha ali não aparece.

| tela | hook | como lê | o importado aparece? |
|---|---|---|---|
| Card "Sugestões de visita" do dashboard (`VisitSuggestionsCard.tsx`) | `src/hooks/useMyVisitSuggestions.ts` | cidades com `visit_score > 30` da carteira (`farmer_id` = dono, mais as carteiras que a pessoa cobre); depois as **30 primeiras da cidade por `visit_score` desc**, e o `pickDailyMix` escolhe 6 com teto de 50% por missão. Cidade padrão = a que tem mais candidatos | Sim, se já tem linha, e **no topo**: ver abaixo |
| Lista de ligação da rota (`RotaListaLigacao`, `RotaPropostas`, fila crítica) | `src/queries/useRouteContactList.ts` | candidatos das cidades-alvo do dia pelo `city_norm`; `pConverte = visit_score / 100`; valor esperado = `pConverte × ticket esperado × margem × prontidão` | Sim, se já tem linha. Mas sem histórico o ticket esperado é 0, então o valor esperado é 0 e o cliente vai para o fim da lista. Efeito pequeno aqui |

Dos 6.577 pendentes, **6.131 ainda não têm linha** em `customer_visit_scores` (invisíveis nas duas telas) e 446 têm uma
linha velha.

## O score que o importado recebe

`scoreProspeccao` (`supabase/functions/visit-score-recalc-client/index.ts:219`, espelho em
`src/lib/visit-scoring/missions.ts:126`):

- é candidato a prospecção quem tem `sales_orders_count === 0` ou `is_prospect`;
- base 70, **+20 se `days_since_signup < 30`**, +10 com sinal de classe ativado.

O `days_since_signup` vem de `profiles.created_at`. Para o importado, isso é **a data do import**, não um cadastro
novo. Resultado medido nos 4.286 da onda de 02/11 já processados: 4.248 sem pedido nenhum, missão `prospeccao`,
`visit_score` **90,0** de média. Na tabela inteira:

| | linhas em `customer_visit_scores` | `visit_score` médio | mediana |
|---|---:|---:|---:|
| sem histórico de compra (`days_since_last_purchase` nulo) | 4.254 | 89,9 | 90 |
| com histórico | 6.648 | 65,0 | 70 |

10.698 das 10.902 linhas estão acima de 30, então o filtro `visit_score > 30` do card quase não filtra.

Dos 6.577 pendentes, 6.119 não têm `days_since_last_purchase` nem `sales_history_status` (nulo = "ainda não computado"
pelo `calculate-scores`, segundo `2026-06-21-sales-history-status.md`), e só 6 desses têm algum `sales_orders`. 388 são
`ativo`, 59 `stale` e 11 `sem_historico`. 6.546 têm dono elegível em `carteira_assignments`; 6.576 têm cidade.

## O efeito para o farmer, em números

**Hoje, sem drenar mais nada**, as 30 primeiras de cada cidade (a query do card) já são quase só clientes sem pedido:

| dono da carteira | cidades | vagas no top 30 | dessas, sem nenhum pedido | cidades com 1 comprador no top 30 |
|---|---:|---:|---:|---:|
| Tatyana | 138 | 1.719 | **1.682** (98%) | 18 |
| Lucas | 164 | 1.552 | **1.495** (96%) | 35 |
| Regina | 55 | 540 | **456** (84%) | 33 |

Na **cidade padrão** do card, o top 30 é 100% sem pedido: Belo Horizonte para a Tatyana (978 candidatos) e Divinópolis
para a Regina (302). Como as 30 candidatas são todas prospecção, o teto de 50% por missão do `pickDailyMix` não protege:
a 2ª passada completa as 6 vagas com mais prospecção. **As 6 sugestões do dia são clientes que nunca compraram, e o
cliente ativo que deveria ser visitado fica fora.**

Os 6.577 pendentes são da Tatyana (6.303), da Regina (244) e do Lucas (30). Quando forem drenados, ~6.100 clientes sem
pedido ganham 90 e entram em mais cidades. **Mais vazão no drain = mais tela errada mais cedo.**

O custo real do atraso, separado disso: **458 clientes com histórico (388 ativos, 59 stale, 11 sem histórico) esperam
desde 02/11** atrás da onda, e o 1º cliente com pedido está na posição 216 da fila. A mudança de score deles leva ~14
dias para chegar à tela. E o 90 não decai sozinho: só é recalculado quando o `farmer_client_scores` muda de novo ou
quando há ligação ou visita nos últimos 30 dias.

## Uso: ninguém registrou visita nem ligação, nunca

`farmer_calls` e `route_visits` estão **vazias desde sempre** (`count(*) = 0`, `n_tup_ins = 0` desde o restart de 31/10,
heap de 0 e 8 kB; o `claude_ro` tem `rolbypassrls = true`, então não é RLS escondendo linha). O ramo de decay do batch
nunca acha ninguém, e não há sinal positivo de uso da sugestão de visita em prod. Pela regra "fase N+1 exige sinal da
fase N" (`docs/historico/fase-sem-sinal.md`), não há base para investir em vazão do drain agora.

## A decisão para o founder

| opção | o que é | efeito na tela | custo |
|---|---|---|---|
| **(a) como no plano: aumentar a vazão** | `max_drain` maior ou o job 60 mais vezes por dia (3–4 dias em vez de 14) | **Piora.** ~6.100 clientes sem pedido a mais com 90 no topo | baixo |
| **(b) como no plano: parar de enfileirar o importado** | filtrar `omie_import` no gatilho | **Desliga o score de toda a carteira** (todo cliente é `omie_import`) | baixo, mas errado |
| **(c) recomendada: consertar o score do importado, depois deixar o drain como está** | 1) não contar a data do import como cadastro (`omie_import` não ganha o +20); 2) decidir se cliente da carteira sem pedido deve ser prospecção acima de quem compra, ou ficar abaixo (ex.: base menor que a mediana de quem compra, ou exigir `sales_history_status` computado); 3) reenfileirar os 4.254 sem histórico que já têm linha (média 89,9) | O top 30 volta a ter compradores. O drain de 500 por dia passa a dar conta (o normal é 4 a 150 por dia) | mexe na regra de missão (edge `visit-score-recalc-client` + espelho em `missions.ts`); pede a decisão do item 2 |

Pergunta ao founder, para fechar o item 2: **um cliente que está na carteira do Omie e nunca fez pedido deve aparecer
nas sugestões de visita antes de um cliente ativo?** Se não, a (c) é o caminho. Se sim, a regra fica como está e a
única coisa a fazer é a parte 1 (o +20 é fabricado pela data do import em qualquer caso).

O atraso dos 458 compradores se resolve sozinho até ~25/11 sem mexer em nada; com a (c), os que estão esperando podem
ser reenfileirados à frente se o founder quiser.

## Como refazer a medição

Tudo por `~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1` com marcador de fim. As consultas desta nota: fila por origem e
motivo, enfileirados e processados por dia (15 d), pendentes por dono, distribuição de `visit_score` por histórico de
compra, top 30 por (dono, cidade) com `visit_score > 30` e contagem de quem não tem `sales_orders`, e
`farmer_calls`/`route_visits` com `count(*)`, `pg_relation_size` e `rolbypassrls`.
