# Runbook — recriar `idx_radar_lista_estab` e `idx_radar_lista_novas` com `NULLS LAST` (B4 do plano v9)

> **Quem roda:** o founder, no SQL Editor do Lovable/Supabase, **um bloco por execução**. A sessão Claude não escreve na prod.
> **Origem:** item B4 RADAR-INDICES-LISTA do [plano v9](../superpowers/plans/2026-11-11-plano-melhoria-v9/README.md); números e `EXPLAIN` em [banco-diagnostico-lote5-v9.md](../historico/banco-diagnostico-lote5-v9.md).
> **Não é migration do repo:** `CREATE/DROP INDEX CONCURRENTLY` não roda dentro de transação, e a migration roda. O SQL fica aqui, e o estado final é conferido por `psql-ro`.

## Por que

A lista do Radar (`radar_lista`) ordena por `ORDER BY e.<col> DESC NULLS LAST, e.cnpj`. Os dois índices são `(<col> DESC, cnpj)`, que no Postgres é `DESC NULLS FIRST`: **não casam**, e o planejador não os usa. Medido por `EXPLAIN` com os parâmetros reais da tela (lote vigente `2026-10`):

- preset **novas** (`data_abertura`): `Parallel Seq Scan` do heap inteiro (~731 MB, 93.511 páginas; a tabela com índices tem 1.427 MB) + `Sort` de 250 a 325 mil linhas de 808 bytes, a cada página pedida;
- preset **estabelecidas** (`capital_social`): `Sort` de 125 a 160 mil linhas, lendo o `idx_radar_empresas_fila` e filtrando;
- o mesmo SELECT com a ordem do índice (`DESC` sem `NULLS LAST`) vira `Index Scan` com custo de **11 e 24** contra **110 mil e 103 mil**: o índice resolve, a ordenação é que não casa.

O irmão `idx_radar_lista_score` já é `DESC NULLS LAST` e é usado (preset score).

## O que muda e o que não muda

Troca dois índices parciais por equivalentes com a ordem certa. **Nenhuma linha muda.** O tamanho fica igual (~58 MB e ~43 MB). Enquanto o índice novo é construído, o antigo continua valendo: a lista nunca fica sem índice. `CONCURRENTLY` não bloqueia escrita, mas lê o heap inteiro uma vez por índice (~731 MB cada, uma única vez): **não rode durante a carga mensal do Radar** (`radar_ingest_state.carga_fase` diferente de `publicada`).

## Pré-voo (somente leitura)

```sql
SELECT c.relname, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid)) AS tam, s.idx_scan, pg_get_indexdef(c.oid) AS def
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_stat_all_indexes s ON s.indexrelid = c.oid
WHERE c.relname IN ('idx_radar_lista_estab','idx_radar_lista_novas','idx_radar_lista_estab_nl','idx_radar_lista_novas_nl');
-- Esperado: só os 2 antigos, indisvalid = true. Se aparecer um *_nl, é sobra de tentativa anterior: DROP INDEX CONCURRENTLY IF EXISTS <nome>; antes de seguir.
SELECT mes_referencia, status, carga_fase FROM public.radar_ingest_state ORDER BY mes_referencia DESC LIMIT 1;
-- Esperado: status = complete e carga_fase = publicada (sem carga em curso).
```

## Passos (um por execução, nesta ordem)

```sql
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_radar_lista_novas_nl
  ON public.radar_empresas (data_abertura DESC NULLS LAST, cnpj)
  WHERE (ja_cliente = false) AND (prospeccao_status <> 'descartado'::text);
```

```sql
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_radar_lista_estab_nl
  ON public.radar_empresas (capital_social DESC NULLS LAST, cnpj)
  WHERE (ja_cliente = false) AND (prospeccao_status <> 'descartado'::text);
```

Prova antes de largar os antigos (os dois `indisvalid = true` e o plano **sem `Sort`**, usando o `_nl`):

```sql
SELECT relname, indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE relname LIKE 'idx_radar_lista_%_nl';
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false
  ORDER BY e.data_abertura DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 0;
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false
  AND e.data_abertura <= '2021-11-11' ORDER BY e.capital_social DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 0;
-- Esperado nos dois: Limit -> Index Scan using idx_radar_lista_novas_nl / idx_radar_lista_estab_nl, sem nó Sort.
-- Se um índice sair invalid (indisvalid = false): DROP INDEX CONCURRENTLY idx_radar_lista_<x>_nl; e refaça o passo. Não siga.
```

Só com a prova verde, trocar (um comando por execução):

```sql
DROP INDEX CONCURRENTLY public.idx_radar_lista_novas;
```

```sql
ALTER INDEX public.idx_radar_lista_novas_nl RENAME TO idx_radar_lista_novas;
```

```sql
DROP INDEX CONCURRENTLY public.idx_radar_lista_estab;
```

```sql
ALTER INDEX public.idx_radar_lista_estab_nl RENAME TO idx_radar_lista_estab;
```

## Pós-voo e reversão

A sessão confere por `psql-ro`: os dois nomes originais, `indisvalid`, definição com `NULLS LAST` e o `EXPLAIN` acima sem `Sort`.

Reversão (se a lista regredir): recrie com o SQL do pré-voo trocando a definição para a antiga (`(<col> DESC, cnpj)`), pelos mesmos passos. Não há dado a restaurar.

## O que NÃO fazer

- **Não** dropar os dois sem recriar: o preset novas e o estabelecidas voltariam a ler ~731 MB de heap por página, e o tamanho recuperado (~100 MB) é de disco, não de memória.
- **Não** rodar `CREATE INDEX` sem `CONCURRENTLY` (bloqueia a escrita na `radar_empresas`).
- **Não** colar os passos todos de uma vez: `CONCURRENTLY` falha dentro de transação, e o SQL Editor pode embrulhar um colar múltiplo.
