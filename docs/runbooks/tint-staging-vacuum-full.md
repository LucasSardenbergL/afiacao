# Runbook — `VACUUM FULL` do staging de fórmulas tint (T2 do plano v8)

> **Quem roda:** o founder, no SQL Editor do Lovable/Supabase. A sessão Claude não escreve na prod.
> **Origem:** item T2 TINT-STAGING-INCHADO do [plano v8](../superpowers/plans/2026-11-10-plano-melhoria-v8/README.md).
> Medido via psql-ro em 2026-11-11 ~10:40–12:00 UTC e revisto depois da contestação do Codex. Contexto do domínio:
> [`tintometrico.md`](../agent/tintometrico.md) e [`tint-purge-staging-io.md`](../historico/tint-purge-staging-io.md).

## Resumo

1. Pausar a ingestão da loja (`sync_enabled = false`). É reversível, e o conector reenvia o que não foi confirmado.
2. Conferir o pré-voo e guardar a impressão digital do conteúdo.
3. Rodar `VACUUM (FULL, SKIP_LOCKED, ANALYZE, VERBOSE)`, uma tabela por execução. Se passar de 2 minutos, cancelar.
4. Reativar a ingestão.
5. Conferir o pós: tamanho menor e o MESMO conteúdo (contagem exata e impressão digital).

## O que muda e o que não muda

`VACUUM FULL` reescreve a tabela e os índices num arquivo novo, sem as páginas vazias. **Não muda nenhuma linha.** O
`tint_promote_sync_run`, o `tint_staging_purge`, o `tint_receita_versoes_capturar` e o `tint_watchdog_fase5_check`
leem o staging. O balcão não lê (lê `tint_formulas`). Se o comando for cancelado no meio, o arquivo velho continua
valendo e nada se perde.

## A premissa do plano estava errada no número de linhas

O plano diz "176 linhas" e "688 linhas". Esses números são o `n_live_tup` do `pg_stat_user_tables`, uma **estimativa**
que zerou no restart de 31/10 10:33 UTC e não foi recontada: as duas tabelas não tiveram autovacuum nem autoanalyze
desde então (`autovacuum_count = 0`, `autoanalyze_count = 0`). Comparando com a contagem exata:

| tabela | heap | total | `n_live_tup` | `count(*)` exato | tamanho das tuplas | `reltuples` |
|---|---:|---:|---:|---:|---:|---:|
| `tint_staging_formulas` | 291 MB | 321 MB | 7 | **132.891** | 84 MB (662 B/linha) | 134.634 |
| `tint_staging_formula_itens` | 167 MB | 270 MB | 0 | **482.539** | 48 MB (104 B/linha) | 491.639 |

Consequências:

- **O inchaço é de ~65%, não de 99,9%.** As linhas vivas ocupam 12.885 das 37.273 páginas das fórmulas e 7.405 das
  21.433 dos itens. O ganho esperado é heap de ~291 MB para ~100 MB e de ~167 MB para ~60 MB, e os índices de ~132 MB
  para ~40 MB (estimativa: tuplas mais cabeçalho de página, índices recriados do zero). O par deve sair de ~590 MB para
  perto de 200 MB, e o purge diário passa a ler cerca de 1/3 do que lê hoje (de ~1,35 GB para ~0,45 GB por chamada).
- **A integridade não se prova por `n_live_tup`.** Ele está errado antes e muda só por causa do `ANALYZE`. A prova é a
  contagem exata e a impressão digital do conteúdo, que precisam ser iguais, mais o tamanho, que precisa diminuir.
- **`TRUNCATE` quando a fila está vazia não é alternativa: apagaria a fonte.** O staging não é fila transitória. Ele
  guarda a última versão de cada chave de fórmula de **todos** os runs (o `_formulas_latest` do promote lê "across TODOS
  os runs"), e o purge só apaga as versões superadas há mais de 30 dias. Das 132.891 fórmulas, só 4.393 são dos
  últimos 30 dias; o resto é a última versão viva de cada chave.

## `VACUUM` comum antes do `FULL`? Medido: não devolve espaço

O `VACUUM` comum só encurta o arquivo quando as páginas do **fim** estão vazias. Pela página da última linha viva
(`max(ctid)`):

| tabela | páginas | última página com linha viva | o `VACUUM` comum devolveria |
|---|---:|---:|---:|
| `tint_staging_formulas` | 37.273 | 37.190 | 83 páginas (~0,6 MB) |
| `tint_staging_formula_itens` | 21.433 | 21.387 | 46 páginas (~0,4 MB) |

O espaço livre está espalhado pelo meio do arquivo. O `VACUUM` comum o marcaria como reutilizável (o arquivo para de
crescer), mas não o devolve, e o seq scan continua lendo as 37 mil páginas. Para o I/O, que é o motivo do T2, só o
`FULL` resolve. O `VACUUM` comum é a manutenção certa **depois**, para o espaço não voltar a crescer (fim deste
roteiro).

## Quem toca o staging e o que acontece durante o `ACCESS EXCLUSIVE`

`VACUUM FULL` toma `ACCESS EXCLUSIVE` na tabela durante toda a reescrita. **A duração não foi medida e não é
prometida aqui.** Como referência, o purge lê ~1,35 GB em ~18 s (~75 MB/s) nessa instância, e a reescrita lê 291 MB +
167 MB, grava ~160 MB e recria 8 índices com `maintenance_work_mem = 64MB`. O roteiro mede a duração e tem um teto
(2 minutos) abaixo do primeiro ponto em que algo começa a falhar.

| quem | toca | o que acontece se esbarrar no VACUUM | a partir de quanto tempo |
|---|---|---|---|
| edge `tint-sync-agent`, run de **fórmulas** (≈10:00–10:12 UTC todo dia; ≈15:50–18:00 UTC em parte dos dias; domingo 08/11 às 03:04) | **dois requests separados**: cabeçalhos em lotes de 500 (`supabase/functions/tint-sync-agent/index.ts:626`<!--cita: await sb.from("tint_staging_formulas")-->) e itens em lotes de 1.000 (`supabase/functions/tint-sync-agent/index.ts:660`<!--cita: .insert(itemRows)-->); se o dos itens falhar, um `DELETE` dos cabeçalhos (`supabase/functions/tint-sync-agent/index.ts:665`<!--cita: .delete().in("id", affectedIds)-->) | PostgREST entra como `authenticator`: `lock_timeout = 8s`. Lote de cabeçalhos que espera mais de 8 s → as fórmulas do lote viram `errors` no run. Lote de itens que espera → o `DELETE` de limpeza também espera e pode falhar, deixando cabeçalho sem item | **8 s** |
| consequência disso no dado | — | **fail-closed e autocurável.** O cabeçalho sem item é barrado pelo `_eu_incompleta` do promote (Fase 1c: `expected_item_count` ≠ itens ingeridos, "fecha o subconjunto que atravessa fronteira de chunk (cleanup falho)"), e o oficial fica com a receita anterior. O conector só avança o HWM com o lote **confirmado** (`ok` e `error_count = 0`, `connector/sayersync/sync.go:911-960`), então reenvia no próximo ciclo (10 min) | — |
| `tint_promocao_tick` (cron 187, a cada 15 s) → `tint_promote_sync_run` | lê `tint_staging_formulas` pelo `sync_run_id` em **todo** run, inclusive de catálogo (3.880 runs em 7 d, a cada ~2,5 min o dia todo) | o tick põe `lock_timeout = 120s` em volta do promote. Até 120 s: só espera. Passou: a tentativa falha e é reagendada (+1 min, +2 min). Na 3ª falha, o run fica `promocao_status = 'erro'` e precisa de gente | **120 s** por tentativa; `erro` só com o lock preso por ~7 min |
| `tint_staging_purge` (cron 236, 05:23 UTC) | lê e apaga | espera (`lock_timeout = 20min`) | — |
| `tint_receita_versoes_capturar` (05:03 UTC), `tint_watchdog_fase5_check` (09:30 e 21:30 UTC) | leem | esperam (sem `lock_timeout` próprio) | — |
| `private.expurgar_logs_tint` (minuto :41) | — | `lock_timeout = 5s`; evite o :41 por precaução | 5 s |

### Por que pausar a ingestão, e não só confiar no `lock_timeout`

- **O `lock_timeout` limita só a ESPERA para pegar o lock, não o tempo em que o VACUUM o segura.** Ele evita a fila de
  lock (o VACUUM esperando atrás de uma leitura longa e travando quem chega depois), mas não protege a edge, que espera
  atrás de um VACUUM já em curso. Para a edge, o teto é de 8 s, e não há como provar antes que a reescrita cabe nisso.
- **No SQL Editor, `SET lock_timeout` não vai junto do `VACUUM`.** Várias instruções numa execução viram um bloco de
  transação implícito, e `VACUUM` dentro dele falha com `25001`. Em execuções separadas, o `SET` pode cair noutra
  conexão. O equivalente numa instrução só é o **`SKIP_LOCKED`**: se o lock não sai na hora, a tabela é pulada com
  `WARNING: skipping vacuum of "..." --- lock not available` e nada acontece.
- **A janela sozinha não fecha a corrida.** Os runs de fórmulas vêm do ciclo de 10 min do conector, não de um horário
  fixo. A janela reduz a chance; a pausa a elimina.
- **A pausa é barata e não perde dado.** Com `sync_enabled = false`, a edge responde 401 para a loja
  (`validateAgent`, `supabase/functions/tint-sync-agent/index.ts:163`<!--cita: if (!data || !data.sync_enabled) return null;-->), o conector trata como lote não confirmado e não avança o HWM. Ao religar, ele
  reenvia tudo no ciclo seguinte. Há uma loja só (`oben`/`M01`, `automatic_primary`).
- **Os consumidores não precisam de pausa.** Eles só esperam, até 120 s no caso do tick. O teto de 2 minutos do passo 3
  fica abaixo disso.

Sem a pausa, o pior caso já é fail-closed (a receita oficial fica a anterior e o conector reenvia em 10 min). A pausa
existe para não depender disso.

`pg_repack` (disponível, não instalado) evitaria o lock longo, mas pede extensão nova e o binário cliente fora do
banco. Com a pausa, não compensa.

## A janela

Padrão medido em 7 dias (05–11/11, `tint_sync_runs` com linhas em `tint_staging_formulas`):

| dia | runs de fórmulas (UTC) |
|---|---|
| 05/11 | 10:02 |
| 06/11 | 10:05 · 15:52 |
| 08/11 (dom) | 03:04 · 03:14 |
| 09/11 | 10:11 · 16:05 |
| 10/11 | 10:02 · 17:56 |

**Janela recomendada: 12:30–15:30 UTC (09:30–12:30 em São Paulo), em dia útil, longe do minuto :41.** Também serve
19:00–21:15 UTC. **Evite:** 03:00–03:30 · 05:00–05:30 · 09:25–10:20 · 15:45–18:15 · 21:25–21:40 UTC. Com a pausa, a
janela é segunda camada.

## Passo 1 — pausar a ingestão (escrita, 1 linha)

```sql
UPDATE public.tint_integration_settings SET sync_enabled = false
WHERE account = 'oben' AND store_code = 'M01' AND sync_enabled
RETURNING account, store_code, sync_enabled;
```

Tem de voltar **1 linha** com `sync_enabled = false`. Se voltar 0 linhas, a loja já estava pausada por outro motivo:
pare e pergunte antes de seguir (o passo 4 religaria algo que alguém desligou). Anote a hora: é o **T0** do passo 2.

## Passo 2 — pré-voo (read-only; rode e guarde o resultado)

```sql
-- P1: tamanho, arquivo e contagem EXATA (não use n_live_tup: é estimativa e zerou no restart)
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

Em 11/11 deu `heap_bytes` 175.579.136 (itens) e 305.340.416 (fórmulas), `linhas` 482.539 e 132.891, `relfilenode` 140165
e 140158. **Anote os seis números.**

```sql
-- P2: run pendente ou recente? Tem de vir VAZIO.
SELECT id, sync_type, status, promocao_status, created_at
FROM public.tint_sync_runs
WHERE created_at > now() - interval '2 days'
  AND (promocao_status = 'pendente'
       OR (sync_type = 'formulas' AND created_at > now() - interval '20 minutes'))
ORDER BY created_at DESC;
```

Com a ingestão pausada, nenhum run novo chega. Uma linha `catalogs` pendente: espere um minuto (o tick promove em
segundos) e rode de novo. Uma linha `formulas` de menos de 20 min: espere a promoção dela terminar.

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
velha: não mate sem entender de quem é; o `SKIP_LOCKED` só vai pular a tabela.

```sql
-- P5: impressão digital do CONTEÚDO (independe da ordem física; ~15 s). Troque o T0 pela hora do passo 1.
SELECT 'formulas' AS t, count(*) AS linhas, sum(hashtextextended(f::text, 0)) AS digital
FROM public.tint_staging_formulas f WHERE f.created_at < 'T0'::timestamptz
UNION ALL
SELECT 'itens', count(*), sum(hashtextextended(i::text, 0))
FROM public.tint_staging_formula_itens i
JOIN public.tint_staging_formulas f ON f.id = i.staging_formula_id
WHERE f.created_at < 'T0'::timestamptz;
```

A `digital` é a soma do hash de 64 bits da linha inteira (todas as colunas, `id` incluído). O `VACUUM FULL` não muda
valor nenhum, então ela tem de sair idêntica. O recorte `created_at < T0` deixa de fora o que chegou depois da pausa.
Testada em 11/11 com `T0 = 2026-11-11 00:00+00`, em duas execuções separadas por ~1 h e com o mesmo resultado:
132.891 / 363670574618072434919 e 482.539 / 1064669202967600265074. **Anote as duas linhas.**

> Teste das consultas deste roteiro: P1 a P6 rodaram na prod via psql-ro (`ON_ERROR_STOP=1`, exit 0, marcador de
> fim). Os dois `UPDATE` dos passos 1 e 4 **não** foram testados: o `claude_ro` não tem `UPDATE` em
> `tint_integration_settings` (`42501`). O `VACUUM` também não, porque é escrita.

## Passo 3 — o comando (UMA instrução por execução, nada mais no editor)

Primeiro os itens (menor), depois as fórmulas. Cada bloco abaixo é uma execução separada: apague o editor, cole só ele,
rode e leia a saída.

```sql
VACUUM (FULL, SKIP_LOCKED, ANALYZE, VERBOSE) public.tint_staging_formula_itens;
```

```sql
VACUUM (FULL, SKIP_LOCKED, ANALYZE, VERBOSE) public.tint_staging_formulas;
```

- **Teto de 2 minutos por execução.** Passou disso, cancele: botão de parar do editor ou, de outra aba,
  `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'VACUUM (FULL%';`. O cancelamento desfaz
  tudo e o arquivo velho continua valendo. Fica abaixo dos 120 s do tick, e nenhuma promoção chega a falhar.
- Saiu `WARNING: skipping vacuum of ... lock not available`: nada foi feito. Rode P2/P3 e repita em um minuto.
- Saiu `ERROR: 25001 ... transaction block`: havia outra instrução na mesma execução. Deixe só o `VACUUM`.
- **Anote a duração de cada execução.** É a medida que falta para as próximas vezes.
- O `ANALYZE` junto conserta as estatísticas de planejamento, sem coleta desde 31/10.

## Passo 4 — religar a ingestão (mesmo se o passo 3 falhou)

```sql
UPDATE public.tint_integration_settings SET sync_enabled = true
WHERE account = 'oben' AND store_code = 'M01' AND NOT sync_enabled
RETURNING account, store_code, sync_enabled;
```

Tem de voltar 1 linha com `sync_enabled = true`. Em até 10 min o conector reenvia o que ficou pendente.

## Passo 5 — pós (evidência positiva; vale para as duas tabelas)

Rode o **P5** com o MESMO T0, e depois o **P1**. Para cada tabela:

1. **P5 idêntico ao do pré-voo**: mesmas `linhas` e mesma `digital`. É a prova de que nenhuma linha mudou. Diferente
   → pare e chame a sessão. Não rode de novo.
2. **`relfilenode` diferente do anotado**: a reescrita aconteceu. Igual → foi pulada (`SKIP_LOCKED`) ou cancelada.
3. **`heap_bytes` menor que o anotado.** O esperado é ~100 MB nas fórmulas e ~60 MB nos itens. Se diminuiu bem menos
   que isso, anote o número; não é falha, mas a estimativa estava errada.

```sql
-- P4: estatísticas de volta (só informativo: n_live_tup é estimativa)
SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_analyze
FROM pg_stat_user_tables
WHERE relname IN ('tint_staging_formulas', 'tint_staging_formula_itens');
```

```sql
-- P6: a ingestão voltou (rode ~15 min depois do passo 4: tem de haver run novo, sem promoção em erro)
SELECT sync_type, status, promocao_status, count(*), max(created_at)
FROM public.tint_sync_runs
WHERE created_at > now() - interval '30 minutes'
GROUP BY 1, 2, 3;
```

## Passo 6 — no dia seguinte (a sessão confere via psql-ro)

- Runs de fórmulas desde a janela com `errors = 0` e nenhum `promocao_status = 'erro'`.
- Duração do `tint-staging-purge-diario` (cron 236) em `cron.job_run_details`: hoje ~18 s; deve cair.
- Delta de `heap_blks_read` em `pg_statio_user_tables` nas duas tabelas em volta do purge das 05:23.

## O espaço volta a crescer? (follow-up, decisão do founder)

Sim, devagar. O purge apaga ~370 fórmulas e ~2.100 itens por dia (4.088 e 23.581 desde o restart de 31/10), e o
autovacuum dessas tabelas só dispara com 20% de linhas mortas (~27 mil fórmulas e ~98 mil itens). Até lá, o espaço
apagado não volta ao mapa de espaço livre, e os inserts novos crescem o arquivo. Duas saídas, nenhuma implementada aqui:

- **Recomendada:** `ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000)`
  nas duas tabelas, por migration. O autovacuum comum marca o espaço como reutilizável sem lock exclusivo. É o que
  evita repetir este roteiro.
- Repetir este roteiro de tempos em tempos. Pior: lock exclusivo e trabalho manual.

O que a recomendada não resolve é que o purge varre o heap inteiro a cada chamada; isso é do D12 do plano v8.
