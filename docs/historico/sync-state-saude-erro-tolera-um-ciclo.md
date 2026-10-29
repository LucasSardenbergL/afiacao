# sync_state_saude: 1 run que falhou não é "Sync Omie PARADO" (2026-10-28)

## Sintoma

E-mail urgente `[Saúde de dados] sync_state_saude — Sync Omie PARADO: reposicao_estoque_full/oben (falhou)`
em 27/10 17:00 BRT. Diagnóstico (skill `diagnose-supabase-sync`): o intraday das 19:40Z do
`omie-sync-estoque` estourou o teto de 80s esperando o Omie (`TimeoutError: Signal timed out.`). Os
runs das 09:05 às 17:40Z do mesmo dia tinham passado em 46–54s. Nos 21 dias anteriores foram 176
runs ok de 179, e nenhuma das 3 falhas se repetiu no run seguinte. O próximo ciclo corrigiria sozinho.

## O padrão (medido, `fin_alertas` tipo `data_health_sync_state_saude`, 29/08 → 27/10)

**42 alertas, 29 resolvidos sozinhos em ≤ 3h.** Quase todos eram **um único run perdido**:

- `reposicao_estoque_full/oben`: o diário das 09:00Z recusado como "Consumo redundante", ou um
  timeout no intraday;
- `inventory/*`: uma rodada de `*/30` ou `1h` que falhou.

Causa no sensor: o eixo 1 do check (status auto-declarado) tratava **qualquer** `status='error'` como
`broken` na hora. Isso valia mesmo com o último sucesso de 2h atrás e o próximo ciclo a caminho. A
confirmação em 2 rodadas do watchdog não segura esse caso, porque o marcador fica `error` até o
próximo run, que no estoque pode estar a 13h de distância.

## A mudança (`20261028000116_data_health_sync_state_erro_tolera_um_ciclo.sql`)

Só no check `sync_state_saude` do `_data_health_compute`:

- A lista de pares com SLA (eixo 2) passou a ser um `WITH req`, lido pelos **dois** eixos.
- Eixo 1: um `'error'` de par **da lista** só vira `broken` quando o último sucesso (`last_sync_at`)
  já passou do SLA do par, ou seja, quando a falha persistiu além de 1 ciclo. Dentro do SLA ele vale `ok`.
- Fail-closed: alguns casos continuam acendendo **na hora**, como antes:
  - par fora da lista (cadência desconhecida);
  - `last_sync_at` NULL;
  - writer que carimba `last_sync_at` no próprio erro (`last_sync_at >= updated_at - 1 min`).
- `('reposicao_estoque_full','oben', 16h)` entrou na lista. O pior intervalo entre sucessos com uma
  falha é 15h25m (o das 19:40Z falha, e o próximo é o diário das 09:05Z). Com 16h, 1 run perdido é
  tolerado e o 2º seguido acende. O par ganhou também o eixo de estagnação, que antes não tinha.
- O buraco diurno (2 runs perdidos seguidos, por exemplo 11:40 e 13:40) fica com o check
  `estoque_reposicao`. Ele lê o DADO (`sku_estoque_atual`) e acende com 4h em horário comercial.
- `running` órfão e `partial` **não** mudam. Watchdog e heartbeat também não, porque não há source novo.

**Invariante de que a regra depende:** o writer **não** avança `last_sync_at` num erro.
`omie-sync-estoque` (`publicacao.ts:161`) e `omie-analytics-sync` (`updateSyncState` só com
`status`/`error_message`) cumprem. A guarda do carimbo cobre um writer futuro que não cumpra.

**Preço:** uma quebra real num par da lista passa a ser acusada no SLA do par, e não mais em ~1h.
Os limites são 3h para `inventory/vendas`, 6h para os outros `inventory` e 16h para o estoque. No
estoque, de dia, quem acusa antes é o `estoque_reposicao`.

**Fora do escopo:** `pedidos_compra/oben (coleta parcial)` (7 episódios de 4–30h). O `partial` avança
`last_sync_at` (`omie-sync-pedidos-compra`), então a idade do último sucesso não serve para
separar 1 ciclo de vários. Além disso, o par já tem check dedicado (`pedidos_compra_sync`).

**Comentário velho na edge:** `omie-sync-estoque/index.ts:989` diz "broken imediato no check". A
frase ficou falsa, mas não foi editada de propósito: mexer na edge muda o fingerprint e cria deploy
sem mudança de comportamento. Atualize na próxima mudança real da edge.

## Prova

`db/test-data-health-sync-state-erro-tolera.sh` (PG17, cadeia viva até o md5 de prod, relógio
controlado): 20 asserts. A falsificação tem 7 sabotagens, todas vermelhas no assert declarado e com
controle verde na mesma invocação. Roda nos dois idiomas do servidor (C e pt_BR.UTF-8).
