# Índices do lote 7 do plano v4 (B4, B5, B6, B7)

Migration `supabase/migrations/20261101201804_indices_lote7_seq_scans.sql`. Plano:
`docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md`.

## Antes (prod, psql-ro, 2026-11-01)

Contadores de `pg_stat_user_tables` desde o restart de 2026-10-31 (~34 h).

| Tabela | Linhas | Seq scans | Consulta real (forma do PostgREST) | Plano antes |
|---|---|---|---|---|
| `sales_orders` | 32.155 | 20.918 | `.eq('customer_user_id').is('deleted_at',null).order(...)` (9 leituras em `src/`) | cliente mediano: Seq Scan, 4.962 buffers, 11,9 ms. Genérico: anda o `idx_sales_orders_active` inteiro filtrando o cliente |
| `fin_sync_log` | 24.150 | 5.108 | `.in('action',…).eq('status','complete').order('completed_at desc').limit(1)` | Seq Scan + top-N sort, 1.442 buffers, 8 ms (literal e genérico) |
| `tint_importacoes` | 116.586 | 141 | `.eq('account').order('created_at desc').limit(1\|3)` | Seq Scan de 116 k linhas + sort, 60 ms |
| `addresses` | 9.626 | 3.637 | `.eq('user_id')` (1 endereço por usuário) | Seq Scan, 57 buffers, 1 ms |

## Decisões

- **`sales_orders(customer_user_id, created_at DESC)`, completo.** A policy
  `sales_orders_select_customer` não tem `deleted_at IS NULL`, e hoje não há linha deletada, então o
  parcial não economizaria nada. `created_at DESC` atende sem sort o `.order(created_at desc).limit(n)`
  de 5 das 9 leituras (o maior cliente tem 1.129 pedidos).
- **`fin_sync_log(action, status, completed_at DESC)`, sem predicado parcial.** O PostgREST manda
  `status` como parâmetro, e `WHERE status='complete'` não pode ser provado contra `status = $1` no
  plano genérico. Com `action` na frente, o mesmo índice atende as funções da prod que filtram
  `action = X AND status = 'complete'` (`fin_sync_heartbeat`, `venda_prazo_aviso`,
  `cobranca_quitacao_ok`, `venda_sync_dia_coberto`).
- **`tint_importacoes(account, created_at DESC)`.** Só o índice: o expurgo da tabela fica no lote 12.
- **`addresses(user_id)`.** Ganho real por leitura (~20× menos buffers), pequeno no total. Custo
  quase nulo: ~300 kB, tabela quase sem escrita.
- **Sem `CONCURRENTLY`.** Os dois caminhos de apply são transacionais, e o `db:aplicar` recusa o
  comando. `CREATE INDEX` comum pega SHARE lock: a leitura segue normal e só a escrita espera um
  build de fração de segundo. `SET LOCAL lock_timeout = '10s'` evita que o CREATE fique na fila
  atrás de uma transação longa.

## Depois (ensaio PG17 local, dados sintéticos na distribuição medida)

`hypopg` não está instalado na prod, então o "depois" foi medido localmente. O arquivo real foi
aplicado duas vezes (idempotência). Controle negativo: um homônimo com outra definição reprovou a
pós-condição com a mensagem esperada.

| Consulta | Antes | Depois |
|---|---|---|
| `sales_orders`, cliente mediano | Seq Scan, 2.988 buffers | Bitmap no índice novo, 7 buffers |
| `sales_orders`, maior cliente, `limit 20` | `idx_sales_orders_active`, 335 buffers | índice novo, 22 buffers, sem sort |
| `sales_orders`, genérico `$1` | `idx_sales_orders_active` com filtro | `Index Cond: customer_user_id = $1` |
| `fin_sync_log`, literal e genérico | Seq Scan, 1.613 buffers | Index Only Scan, 25 buffers |
| `fin_sync_log`, `max()` do heartbeat | Seq Scan, 1.610 buffers | Index Scan, 4 buffers |
| `tint_importacoes`, `limit 1` e genérico | Seq Scan + sort, 1.666 buffers | Index Scan, 4 buffers |
| `addresses` | Seq Scan, 104 buffers | Index Scan, 8 buffers |

## Como medir que pegou (depois do apply)

```sql
SELECT s.relname, s.indexrelname, s.idx_scan, x.indisvalid
  FROM pg_stat_user_indexes s JOIN pg_index x ON x.indexrelid = s.indexrelid
 WHERE s.indexrelname IN ('idx_sales_orders_customer_created','idx_fin_sync_log_action_status_completed',
                          'idx_tint_importacoes_account_created','idx_addresses_user_id');
```

Sinal positivo: `idx_scan > 0` e crescendo em cada um. Para ver o efeito nas tabelas, compare o ritmo
de `seq_scan` de `pg_stat_user_tables` com o da tabela "Antes".
