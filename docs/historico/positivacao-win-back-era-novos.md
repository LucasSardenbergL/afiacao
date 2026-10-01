# Placar do farmer: o "win-back" era a contagem de clientes novos

**2026-09-30.** Achado do Codex no adversarial do #2630, preexistente e fora daquele diff,
conferido no código e medido na prod. **Decisão do founder: caminho (a)**, renomear o card
para o que ele conta. O win-back de verdade fica para quando houver sinal de uso (a query está
no fim deste registro). Só front: a RPC não mudou.

## O defeito

- `PositivacaoHero` (ramo farmer) exibia `novos_clientes_positivados` como **"Recuperados
  (win-back) — voltaram a comprar no mês"**. O campo conta o cliente elegível cuja 1ª compra
  válida **da vida** (`min(order_date_kpi)` no universo canônico) cai no mês. É cliente
  NOVO, não cliente que voltou.
- **De onde veio:** o spec `docs/superpowers/specs/2026-06-06-kpis-farmer-meu-dia-design.md`
  (tabela de KPIs) definiu win-back como "1ª compra/**retorno** no mês" e ligou o card em
  `novos_clientes_positivados ✅`. A metade "retorno" nunca existiu na RPC. O mesmo spec diz que
  win-back é placar de gestão e que o OTE "talvez pague em V3", ou seja, não é base de comissão
  hoje.
- **No mesmo placar:** "Clientes a positivar" mostrava `aPositivar.length`, e a RPC corta
  `a_positivar` em `LIMIT 200`. O mesmo 200 aparecia no cabeçalho do `ClientesAPositivarCard`,
  logo abaixo do placar em `/farmer/calls`, e no sensor `carteira.positivacao_vista`
  (propriedade `a_positivar`).

## A medição (psql-ro e PostHog, 2026-09-30)

A RPC da prod é a do repo: o md5 do `prosrc` de `_carteira_positivacao_for_owner` dá
`f1a2bd9e48c7b2c22ff805a50ab524b2`, o corpo da `20260927195430`.

Abaixo, os 3 farmers com carteira elegível atual (a mesma base do ao vivo). "Retorno" quer dizer
que o cliente comprou no mês e a última compra válida antes do mês foi há N dias ou mais.

| mês | positivados | o card dizia (novos) | retorno ≥60d | retorno ≥90d | retorno ≥180d |
|---|---|---|---|---|---|
| 2026-04 | 167 | 1 | 45 | 32 | 16 |
| 2026-05 | 186 | 2 | 68 | 48 | 21 |
| 2026-06 | 159 | 6 | 43 | 29 | 10 |
| 2026-07 | 189 | 1 | 72 | 47 | 24 |
| 2026-08 | 177 | 1 | 53 | 33 | 15 |
| 2026-09 | 179 | 2 | 55 | 39 | 21 |

- **"Clientes a positivar":** os 3 farmers viam **200**. O real era **2.388 / 1.428 / 1.179**
  (elegíveis sem pedido no mês). Todos têm linha em `farmer_client_scores`, então a lista sem
  teto daria a mesma contagem.
- **Uso:** `carteira.positivacao_vista` teve **1 evento em 90 dias** (2026-08-14). O app inteiro,
  em 30 dias, teve 1.764 eventos de **2 pessoas** e 73 pageviews (reposição e `/`). O vazio não
  é captura quebrada: no banco, os 3 donos de carteira **nunca** registraram ligação
  (`farmer_calls`) e não têm visita (`route_visits`) em 30 dias. Não existe sinal de uso da fase
  atual, e a regra "fase N+1 exige sinal" pesou contra abrir agora o ritual money-path do
  win-back.

## O que mudou

- O card de novos virou **um componente** (`NovosNaCarteiraCard`) usado nos **dois** placares,
  com rótulo "Novos na carteira (MTD)", sub "1ª compra neste mês" e o tooltip de proxy de
  aquisição. O farmer e o hunter passaram a chamar o mesmo número pelo mesmo nome.
- `useMyPositivacao` expõe `aPositivarTotal = total_eligible − positivados`, os elegíveis sem
  pedido no mês. É a conta exata, com os mesmos dois termos do card "Positivação MTD". O placar,
  o cabeçalho da lista e o sensor passam a usar esse total. A lista continua mostrando os 30
  primeiros.
- A lista só comemora ("toda a carteira elegível já comprou") quando o **total** é 0. Antes,
  uma lista vazia comemorava mesmo com cliente sem pedido que ainda não tinha score.
- **Sensor:** a propriedade `a_positivar` mudou de "tamanho da lista (≤200)" para "elegíveis sem
  pedido" em 2026-09-30. A série tinha 1 evento em 90 dias, então não há histórico a reconciliar.
- Testes: `src/components/farmer/__tests__/PositivacaoHero.test.tsx` e
  `ClientesAPositivarCard.total.test.tsx` (novos), mais um caso em
  `src/hooks/__tests__/useSinalPositivacao.rotulos.test.tsx`.

## O desempate do corte `a_positivar`: avaliado e NÃO aplicado

O corte é `ORDER BY priority_score DESC NULLS LAST, revenue_potential DESC NULLS LAST LIMIT 200`,
sem chave única. O empate não é caso de borda:

- Nos 3 farmers, o 200º e o 201º empatam em `priority_score = 46`, num bloco de **2.205 /
  1.052 / 858** clientes. Acima de 46 há só **1 / 4 / 17** candidatos. Logo, das 30 linhas
  visíveis, de 13 a 29 saem do bloco em ordem arbitrária.
- `revenue_potential` é nulo em **100%** (6.633 de 6.633), então a 2ª chave é inerte. O
  `churn_risk` tem de 1 a 4 valores distintos no bloco, e a 3ª chave do `rankAPositivar` no
  front também não desempata.
- Composição do bloco (elegíveis): **3.976 `sem_historico`**, com `days_since_last_purchase =
  999` (a sentinela "sem venda" de `src/lib/scoring/salesBase.ts`), e **137 `stale`**, que
  sumiram há 222 a 2.357 dias e são os alvos reais de win-back.

Desempatar por `customer_user_id` deixa o corte **estável, mas continua arbitrário**, porque a
ordem de uuid é aleatória. Isso não paga um ritual money-path sozinho. O defeito de fundo é o
score: o 46 iguala quem nunca comprou a quem sumiu há mais de 222 dias. Quando o win-back
entrar, o desempate vai **na mesma migration**, com chave de negócio: `stale` antes de
`sem_historico`, depois `days_since_last_purchase ASC`, por fim `customer_user_id`.

**Colateral, não corrigido aqui:** a lista exibe "999d sem comprar" para os `sem_historico`
(`ClientesAPositivarCard.tsx`), e o clique leva `dias_sem_comprar: 999` à telemetria. É a
sentinela exibida como se fosse medida. O front não tem como separá-la de uma medida real sem
um campo de status vindo da RPC. Fica para a sessão do win-back, que já vai mexer na RPC.

## Quando o win-back passa a valer: a query

"Quando medir" é query, não recado. Rode com `bash scripts/posthog-query.sh "<query>"`:

```sql
SELECT count() AS vistas, count(DISTINCT person_id) AS pessoas,
       count(DISTINCT toDate(timestamp)) AS dias
FROM events
WHERE event = 'carteira.positivacao_vista'
  AND properties.is_hunter = false AND properties.sob_lente = false
  AND timestamp > now() - INTERVAL 30 DAY
```

Leitura em 2026-09-30: `0 | 0 | 0`. **Gatilho proposto:** pelo menos 1 farmer, fora da lente,
com vistas em 5 ou mais dias distintos dentro de 30 dias. Daí o win-back (b) vira a próxima
fase: chave nova na RPC (retorno após ≥N dias sem comprar), o desempate acima e a sentinela 999,
com o ritual `lovable-db-operator` + `prove-sql-money-path` e 2 consultas Codex. A tabela de
retorno lá em cima foi medida assim: pedidos do universo canônico (o mesmo `pedidos_validos` da
RPC), a última compra antes do mês (`max(order_date_kpi) < início do mês`) e o gap dela até a
1ª compra dentro do mês.

## Deploy

Só front: merge ≠ produção, e o founder clica em **Publish** no Lovable. Não há edge nem
migration.
