# Radar — o expurgo horário relia o heap inteiro por causa do rowmark (plano v8, R2) — 2026-11-11

**Entrega:** `supabase/migrations/20261113110000_radar_expurgo_sem_varrer_heap.sql` (só a etapa (c) de
`public.radar_privacidade_expurgo`), prova PG17 `db/test-radar-privacidade-j.sh` fase I*.

## O sintoma

O job 284 (`41 * * * *`) era o maior leitor de disco da instância. Pelo `pg_stat_statements` (37 chamadas, de 05/11 a 11/11),
o comando de nível superior somava **157.665 blocos lidos fora do shared_buffers por chamada** (~1,2 GiB), mais 697 mil
blocos em cache, com **79,7 s por chamada**. Dá ~29 GiB/dia de leitura para uma tarefa de higiene.

## O diagnóstico (o plano errou o suspeito)

O plano v8 culpava as duas varreduras por regex (o backfill e a contagem `razoes_cruas_restantes`). O EXPLAIN de prod
desmente: as duas já usam o índice parcial `idx_radar_empresas_razao_crua` (Index Only Scan; o backfill leu 48 blocos).

O leitor era a **higiene do cru**:

```sql
DELETE FROM private.radar_razao_receita r
 WHERE NOT EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = r.cnpj) AND NOT EXISTS (… carga …);
```

**Lição (vale para qualquer DELETE/UPDATE com junção):** num UPDATE/DELETE, toda relação **não-alvo** da junção leva
rowmark (`ROW_MARK_REFERENCE`): o executor precisa do ctid dela para o EvalPlanQual. Isso **proíbe o Index Only Scan**
nessa relação. A anti-junção virou um Merge Anti Join que percorre `radar_empresas_pkey` (os ~4,7 mil blocos de índice)
e vai ao heap buscar cada uma das 624 mil linhas (os ~155 mil blocos de heap; o heap tem 93 mil páginas e não cabe nos
256 MB de shared_buffers). EXPLAIN em prod: custo 121.843 no DELETE contra 14.418 na forma SELECT. A mesma anti-junção
escrita como SELECT (EXPLAIN ANALYZE em prod) leu 11.609 blocos em 3 s.

**Correção:** os órfãos saem de uma `WITH … AS MATERIALIZED (SELECT …)`. Ali não há rowmark, então o planner volta a usar o
Index Only Scan. O DELETE só casa o resultado pela PK do cru. É o mesmo snapshot e a mesma semântica, num único comando.
Além disso, a higiene passou a rodar **no máximo 1× a cada ~24 h**: é a 1ª rodada sem uma higiene `sucesso` nas últimas
23 h 30 min. O órfão de cru só nasce de carga abortada ou de empresa que saiu do Radar (carga mensal).

`pg_stat_statements` não mostra os comandos de dentro de uma função plpgsql (`track = top`), mas a linha do comando de
nível superior **soma** o IO deles. Para ver o plano de dentro da função, a prova usa `auto_explain` com
`log_nested_statements = on` e `client_min_messages = log`.

## O que fica (a garantia de LGPD)

O backfill (a) e a contagem `razoes_cruas_restantes` seguem **a cada hora**. Também seguem a cada hora a retenção de
notas (b), a expiração de acessos e as exclusões de titular (d). A prova I1 insere uma razão crua que furou o trigger
(`session_replication_role = replica`) e exige que a rodada seguinte a mascare.

**Resíduos honestos:**
- O cru órfão passa de ~1 h para até ~24 h de retenção.
- O backfill horário só pega o sufixo da RFB (` [0-9]{11}$`). O CPF em formato livre no nome depende dos triggers e da
  regravação única do #3795. Isso já era assim antes desta entrega.
- Na rodada sem higiene, `cru_orfao_apagado` vai como **null**: ausente ≠ zero.

## Medido (pg_statio_user_tables de radar_empresas + pg_stat_statements, por rodada)

Método: `pg_statio_user_tables` lido por psql-ro em 3 fotos — 1 min antes, 20 s antes e logo depois de a rodada entrar
no ledger. Junto, o delta de `pg_stat_statements` do comando `SELECT public.radar_privacidade_expurgo()`, que soma o IO
dos comandos de dentro da função. A janela de 1 min antes teve delta **zero** em `radar_empresas`: a rodada estava isolada.

| Rodada | Corpo | pgss: blocos lidos (fora do cache) | pgss: em cache | duração | radar_empresas heap_read | idx_read |
|---|---|---:|---:|---:|---:|---:|
| 11/11 11:41 | velho (cdb486…) | **161.820** (1,23 GiB) | 536.367 | 68,7 s | 152.356 | 4.695 |
__DEPOIS__
