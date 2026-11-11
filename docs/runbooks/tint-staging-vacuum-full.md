# Runbook — `VACUUM FULL` do staging de fórmulas tint (T2 do plano v8)

> **Quem roda:** o founder, no SQL Editor do Lovable/Supabase. A sessão Claude não escreve na prod.
> **Origem:** item T2 TINT-STAGING-INCHADO de [`plano v8`](../superpowers/plans/2026-11-10-plano-melhoria-v8/README.md).
> Medido via psql-ro em 2026-11-11 ~10:40 UTC. Contexto do domínio: [`tintometrico.md`](../agent/tintometrico.md) e
> [`tint-purge-staging-io.md`](../historico/tint-purge-staging-io.md).

## O que muda e o que não muda

`VACUUM FULL` reescreve a tabela e os índices num arquivo novo, sem as páginas vazias. **Não muda nenhuma linha.** O
`tint_promote_sync_run` e o `tint_staging_purge` leem o staging; nada no app de balcão lê o staging (o balcão lê
`tint_formulas`). Se o comando for cancelado no meio, o arquivo velho continua valendo e nada se perde.

## A premissa do plano estava errada no número de linhas (corrigido aqui)

O plano diz "176 linhas" e "688 linhas". Esses números são o `n_live_tup` do `pg_stat_user_tables`, que **zerou no
restart de 31/10 10:33 UTC** e nunca foi recontado: as duas tabelas não tiveram autovacuum nem autoanalyze desde então
(`autovacuum_count = 0`, `autoanalyze_count = 0`). Como mostra a tabela abaixo, o `count(*)` real é outro:

| tabela | heap | total | `n_live_tup` | `count(*)` real | tamanho das tuplas | `reltuples` |
|---|---:|---:|---:|---:|---:|---:|
| `tint_staging_formulas` | 291 MB | 321 MB | 7 | **132.891** | 84 MB (662 B/linha) | 134.634 |
| `tint_staging_formula_itens` | 167 MB | 270 MB | 0 | **482.539** | 48 MB (104 B/linha) | 491.639 |

Consequências:

- **O inchaço é de ~65%, não de 99,9%.** O ganho esperado é heap de ~291 MB para ~100 MB e de ~167 MB para ~60 MB, e
  os índices de ~132 MB para ~40 MB (estimativa: tuplas + cabeçalho de página, índices recriados do zero). Em vez de
  ~590 MB, o par deve ficar perto de 200 MB. O purge diário passa a ler cerca de 1/3 do que lê hoje (de ~1,35 GB para
  ~0,45 GB por chamada), não 1/1000.
- **A conferência do pós NÃO pode usar `n_live_tup`.** Ele está errado antes e vai mudar só por causa do `ANALYZE`. A
  evidência é `count(*)` igual, `relfilenode` diferente e heap menor.
- **`TRUNCATE` quando a fila está vazia não é alternativa: apagaria a fonte.** O staging não é uma fila transitória. Ele
  guarda a última versão de cada chave de fórmula de **todos** os runs (o `_formulas_latest` do promote lê "across TODOS
  os runs"), e o purge só apaga as versões superadas há mais de 30 dias. Das 132.891 fórmulas, só 4.393 foram criadas
  nos últimos 30 dias; o resto é a última versão viva de cada chave. Um `TRUNCATE` faria a próxima promoção de um par
  (cod_produto, id_base) re-expandir sem as cores antigas, e o `tint_receita_versoes_capturar` perderia a base.

## Quem toca o staging (e o que acontece durante o `ACCESS EXCLUSIVE`)

`VACUUM FULL` toma `ACCESS EXCLUSIVE` na tabela durante toda a reescrita. Quem chegar nesse tempo, leitura ou escrita,
espera.

| quem | quando | toca | o que acontece se esbarrar no VACUUM |
|---|---|---|---|
| `tint_promocao_tick` (cron 187, 15 s) → `tint_promote_sync_run` | a cada run: catálogo a cada ~2,5 min **o dia todo** (3.880 runs em 7 d, 140–205 por hora UTC); fórmulas 9 runs em 7 d | lê `tint_staging_formulas` pelo `sync_run_id` (também nos runs de catálogo) e os itens nos runs de fórmula | **Espera e segue.** O cron roda com `statement_timeout = 20min` e sem `lock_timeout`. A promoção do catálogo atrasa alguns segundos (hoje ela já leva ~35 s entre chegar e ser promovida). Média do tick: 0,11 s. |
| edge `tint-sync-agent`, run de **fórmulas** | ~10:00–10:12 UTC todo dia; ~15:50–18:00 UTC em parte dos dias; domingo 08/11 às 03:04 | `INSERT` em lotes de 500 fórmulas e 1.000 itens via PostgREST; antes, `SELECT` da última versão de cada chave | **Falha.** O PostgREST entra como `authenticator`, que tem `lock_timeout = 8s` e `statement_timeout = 8s`. Se o VACUUM durar mais que 8 s, o lote de 500 fórmulas é contado como `errors` no run. **É o único risco real, e é por isso que a janela evita esses horários.** |
| edge `tint-sync-agent`, run de catálogo | o dia todo | não escreve no staging de fórmulas | nenhum |
| `tint_staging_purge` (cron 236) | 05:23 UTC (~18 s) | lê e apaga | espera (`statement_timeout = 30min`) |
| `tint_receita_versoes_capturar` (cron 243) | 05:03 UTC (~11 s) | lê | espera |
| `tint_watchdog_fase5_check` (cron 167) | 09:30 e 21:30 UTC (~45–65 s) | lê | espera (`statement_timeout = 10min`) |
| `private.expurgar_logs_tint` (cron 259) | minuto :41 de toda hora | — | tem `lock_timeout = 5s`; evite o :41 por precaução |

### `lock_timeout` curto basta?

Não, por dois motivos:

1. **`lock_timeout` limita só a ESPERA para pegar o lock, não o tempo em que o VACUUM o segura.** O risco de lock queue
   (o VACUUM esperando atrás de uma leitura longa e, nessa fila, travando todo mundo que chega depois) ele resolve. O
   risco da edge (que espera atrás do VACUUM já em curso) ele não toca: esse quem resolve é a janela.
2. **No SQL Editor, `SET lock_timeout` não vai junto do `VACUUM`.** O editor manda o script inteiro numa execução só, e
   várias instruções numa execução viram um bloco de transação implícito. `VACUUM` dentro dele falha com
   `25001 VACUUM cannot run inside a transaction block`. Em execuções separadas, o `SET` pode cair noutra conexão.

O que resolve o lado da espera, numa instrução só, é a opção **`SKIP_LOCKED`** do próprio `VACUUM` (PG 17.6 em prod):
se o lock não sai na hora, a tabela é pulada com `WARNING: skipping vacuum of "..." --- lock not available` e nada
acontece. É o equivalente a `lock_timeout = 0` sem o problema da transação. Se isso acontecer, rode de novo um minuto
depois.

**Duração esperada da reescrita:** de 5 a 30 s por tabela. O purge de hoje lê ~1,35 GB em ~18 s (~75 MB/s) nessa
mesma instância; a reescrita lê o heap (291 e 167 MB), grava ~100 e ~60 MB e recria os índices com
`maintenance_work_mem = 64MB`. É estimativa, não medida: o roteiro mede.

**`pg_repack`** (disponível, não instalado) evitaria o lock longo, mas pede extensão nova e o binário cliente fora do
banco. Para segundos de lock numa janela sem run de fórmulas, não compensa.

## A janela

Padrão medido em 7 dias (05–11/11, `tint_sync_runs` com linhas em `tint_staging_formulas`):

| dia | runs de fórmulas (UTC) |
|---|---|
| 05/11 | 10:02 |
| 06/11 | 10:05 · 15:52 |
| 08/11 (dom) | 03:04 · 03:14 |
| 09/11 | 10:11 · 16:05 |
| 10/11 | 10:02 · 17:56 |

Fora daí, ao longo do dia, só os runs de catálogo (a cada ~2,5 min, que só esperam).

**Janela recomendada: 12:30–15:30 UTC (09:30–12:30 em São Paulo), em dia útil, longe do minuto :41.** Também serve
19:00–21:15 UTC. **Evite:** 03:00–03:30 · 05:00–05:30 · 09:25–10:20 · 15:45–18:15 · 21:25–21:40 UTC.

## Passo 1 — pré-voo (read-only; rode e guarde o resultado)

```sql
-- P1: tamanho, arquivo e contagem REAL (não use n_live_tup: zerou no restart)
SELECT c.relname,
       c.relfilenode,
       pg_relation_size(c.oid)                        AS heap_bytes,
       pg_size_pretty(pg_relation_size(c.oid))        AS heap,
       pg_size_pretty(pg_total_relation_size(c.oid))  AS total,
       CASE c.relname
         WHEN 'tint_staging_formulas'      THEN (SELECT count(*) FROM public.tint_staging_formulas)
         WHEN 'tint_staging_formula_itens' THEN (SELECT count(*) FROM public.tint_staging_formula_itens)
       END                                            AS linhas
FROM pg_class c
WHERE c.oid IN ('public.tint_staging_formulas'::regclass, 'public.tint_staging_formula_itens'::regclass)
ORDER BY c.relname;
```

Em 11/11 deu `heap_bytes` 175.579.136 (itens) e 305.340.416 (fórmulas), `linhas` 482.539 e 132.891, `relfilenode` 140165 e 140158. **Anote os
quatro números e os dois `relfilenode`.**

```sql
-- P2: run de fórmulas pendente ou recente? Tem de vir VAZIO.
SELECT id, sync_type, status, promocao_status, created_at
FROM public.tint_sync_runs
WHERE created_at > now() - interval '2 days'
  AND (promocao_status = 'pendente'
       OR (sync_type = 'formulas' AND created_at > now() - interval '20 minutes'))
ORDER BY created_at DESC;
```

Uma linha `catalogs` pendente é normal (o tick promove em segundos); espere um minuto e rode de novo. Uma linha
`formulas` → **pare**: o conector está mandando fórmulas, volte noutra hora.

```sql
-- P3: alguém segurando as tabelas, ou transação aberta há mais de 1 minuto?
SELECT a.pid, l.relation::regclass AS tabela, l.mode, l.granted, a.state,
       now() - a.xact_start AS idade, left(a.query, 80) AS consulta
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE l.relation IN ('public.tint_staging_formulas'::regclass, 'public.tint_staging_formula_itens'::regclass)
   OR (a.xact_start < now() - interval '1 minute' AND a.pid <> pg_backend_pid() AND a.backend_type = 'client backend');
```

Vazio é o esperado. Uma linha do `tint_promote_sync_run` ou do purge: espere terminar. Transação `idle in transaction`
velha: não mate sem entender de quem é; o `SKIP_LOCKED` apenas vai pular a tabela.

## Passo 2 — o comando (UMA instrução por execução, nada mais no editor)

Primeiro os itens (menor), depois as fórmulas. Cada linha abaixo é uma execução separada: apague o editor, cole só ela,
rode, leia a saída.

```sql
VACUUM (FULL, SKIP_LOCKED, ANALYZE, VERBOSE) public.tint_staging_formula_itens;
```

```sql
VACUUM (FULL, SKIP_LOCKED, ANALYZE, VERBOSE) public.tint_staging_formulas;
```

- Saiu `WARNING: skipping vacuum of ... lock not available`: nada foi feito. Rode P2/P3 de novo e repita em um minuto.
- Saiu `ERROR: 25001 ... transaction block`: havia outra instrução na mesma execução. Deixe só o `VACUUM`.
- Anote o tempo que o editor mostrou para cada um. É o dado que falta para as próximas vezes.
- O `ANALYZE` junto também conserta as estatísticas de planejamento, que estavam sem coleta desde 31/10.

## Passo 3 — pós (evidência positiva; os três critérios valem para as duas tabelas)

Rode o P1 de novo. Para cada tabela:

1. **`linhas` igual ao do pré-voo** (salvo inserção de run nesse meio tempo, que a P2 confere). Diferente sem run novo →
   pare e chame a sessão.
2. **`relfilenode` diferente do anotado.** É a prova de que a reescrita aconteceu. Igual → foi pulada (`SKIP_LOCKED`).
3. **`heap_bytes` pelo menos 50% menor.** Esperado: ~100 MB nas fórmulas e ~60 MB nos itens.

```sql
-- P4: as estatísticas voltaram (n_live_tup agora perto do count, last_analyze preenchido)
SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_analyze
FROM pg_stat_user_tables
WHERE relname IN ('tint_staging_formulas', 'tint_staging_formula_itens');
```

## Passo 4 — no dia seguinte (a sessão confere via psql-ro)

- `tint_sync_runs` da janela até agora com `errors = 0` nos runs de fórmulas.
- Duração do `tint-staging-purge-diario` (cron 236) em `cron.job_run_details`: hoje ~18 s; deve cair.
- Delta de `heap_blks_read` em `pg_statio_user_tables` nas duas tabelas antes e depois do purge das 05:23.

## O espaço volta a crescer? (follow-up, decisão do founder)

Sim, devagar. O purge apaga ~370 fórmulas e ~2.100 itens por dia (4.088 e 23.581 desde o restart de 31/10), e o autovacuum dessas tabelas só dispara com 20% de
linhas mortas (~27 mil fórmulas e ~98 mil itens). Até lá o espaço apagado não volta ao mapa de espaço livre, e os
inserts novos crescem o arquivo. Duas saídas, nenhuma implementada aqui:

- **`ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000)`** nas duas
  tabelas, por migration. O autovacuum comum marca o espaço como reutilizável sem lock exclusivo. É o que impede repetir
  o `VACUUM FULL`.
- Repetir este roteiro de tempos em tempos. Pior: lock exclusivo e trabalho manual.

A primeira é a recomendada. O que ela não resolve é que o purge varre o heap inteiro a cada chamada; isso é do D12 do
plano v8.
