# Saúde de dados: "Re-executar" POR ENTIDADE no `sync_state_saude` (2026-11-03)

Extensão da [fase 1](saude-dados-reexecutar-fase1.md) (#3465). Os 5 checks cobertos ali tiveram 0 episódios
vermelhos em 60 dias, então sem o `sync_state_saude` o sensor da fase 1 quase não dispara, e a fase 2 depende
desse sinal. Continua sendo um clique humano: nada de automação, nada de money-path.

## A regra lida em prod (não da `message`)

`pg_get_functiondef('public._data_health_compute'::regproc)`, bloco `sync_state_saude`, lido via psql-ro em 3/11.
O check é **1 linha agregada** (o watchdog exige source único), então o botão é por `(entity_type, account)`:

- **Eixo 1 (auto-declarado, tabela inteira):** `error` → broken se o par não tem SLA, se `last_sync_at` é nulo,
  se o writer carimbou `last_sync_at` no erro (≥ `updated_at` − 1 min) ou se o último sucesso saiu do SLA. Dentro
  do SLA é 1 run perdido e não acende. `running` com `updated_at` acima de 6h → broken (órfão). `partial` → stale.
- **Eixo 2 (estagnação, lista `req` com SLA):** marcador ausente, `last_sync_at` nulo ou além do SLA → broken.
  São 10 pares: customers ×3 (30h), products_metadados ×2 (30h), products/colacor_vendas (30h),
  inventory/vendas (3h), inventory/colacor_vendas e inventory/servicos (6h), reposicao_estoque_full/oben (16h).
- 1 linha por par: broken vence; em empate, o eixo 1 vence.

O espelho em TS é `src/lib/dataHealth/syncState.ts` (`entidadesNaoOk`). O compute continua dono da COR do card. Se o
espelho ficar para trás, a tela mostra "o check acusa, mas a leitura do front não achou entidade não-ok".

## O que ganhou botão

A leitura é de `sync_state` pelo front. A RLS "Staff can manage sync state" libera master/employee.

| Entidade | Disparo (= body do cron) | Slug / escritor |
|---|---|---|
| `inventory/vendas` | `omie-analytics-sync` `{action:'sync_inventory', account:'vendas'}` | `saude_dados.reexecutar_sync_state_inventory_vendas` / front |
| `inventory/colacor_vendas` | idem, `account:'colacor_vendas'` | `saude_dados.reexecutar_sync_state_inventory_colacor_vendas` / front |
| `products/colacor_vendas` | `{action:'sync_products', account:'colacor_vendas', max_pages:50}` | `saude_dados.reexecutar_sync_state_products_colacor_vendas` / front |
| `reposicao_estoque_full/oben` | `omie-sync-estoque` `{empresa:'OBEN'}` | `reposicao.sync_estoque` / **edge** (`comRegistro`) |

Os três da `omie-analytics-sync` respondem 200 síncrono e a edge não registra execução, então o front é o único
escritor do slug. `running` com heartbeat de até 6h mostra "já em andamento" e não dispara, porque a edge não tem
lease nesses handlers e um 2º clique empilharia um 2º run no Omie. Órfão (acima de 6h) ganha botão: o run novo
sobrescreve o marcador.

**Ficam fora, e o teste trava:** `pedidos_compra*` (money-path de compra) e `customers/*` (mexe em identidade e
os aliases fiscais; `sync_customers` responde **202**, ou seja, aceito em background, não concluído). Há duas
camadas, cada uma falsificada com um vermelho próprio: a chave no catálogo e a guarda de `acaoDaEntidade`, que
casa o motivo. `inventory/servicos` e `products_metadados/*` ficaram fora do levantamento e mostram "sem
re-execução por aqui".

## Denominador (fin_alertas, 60 dias até 3/11)

39 episódios de `data_health_sync_state_saude`. Por entidade citada (um episódio pode citar mais de uma):
`reposicao_estoque_full/oben` 21 (p50 0,5h), `pedidos_compra/oben` 6 (p50 7h), `inventory/vendas` 5,
`inventory/colacor_vendas` 3, `inventory/servicos` 2, `pedidos_compra_encerrados/oben` 1, `customers/servicos` 1,
`products/colacor_vendas` 1. **30 das citações caem em entidade com botão.** Parte dos episódios de
`reposicao_estoque_full` é anterior à tolerância de 1 run do compute (28/10), então a taxa daqui em diante deve
ser menor.

## Deploy

Só front: o deploy é o **Publish** no Lovable. Não há migration nem edge.

## Quando medir

```sql
SELECT acao, status, detalhes->>'desfecho' AS desfecho, count(*) FROM public.acoes_execucoes
 WHERE acao LIKE 'saude_dados.reexecutar_sync_state_%'
    OR (acao = 'reposicao.sync_estoque' AND origem = 'manual')
 GROUP BY 1, 2, 3;
```

Cruze com `fin_alertas` (`tipo='data_health_sync_state_saude'`, `resolvido_em`) para saber se o clique encurtou o
episódio. A fase 2 continua exigindo esse sinal **e** um incidente citado por ID.
